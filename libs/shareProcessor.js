var redis = require('redis');
var http = require('http');
var Stratum = require('cryptocurrency-stratum-pool');
var CreateRedisClient = require('./createRedisClient.js');
var mysql = require('mysql');


/*
This module deals with handling shares when in internal payment processing mode. It connects to a redis
database and inserts shares with the database structure of:

key: coin_name + ':' + block_height
value: a hash with..
        key:

 */



module.exports = function(logger, poolConfig){

    var redisConfig = poolConfig.redis;
    var coin = poolConfig.coin.name;
    var coinSymbol = poolConfig.coin.symbol;
    var algo = poolConfig.coin.algorithm;

    var forkId = process.env.forkId;
    var logSystem = 'Pool';
    var logComponent = coin;
    var logSubCat = 'Thread ' + (parseInt(forkId) + 1);
    
    var connection = CreateRedisClient(redisConfig);
    if (redisConfig.password) {
        connection.auth(redisConfig.password);
    }

    connection.on('ready', function(){
        logger.debug(logSystem, logComponent, logSubCat, 'Share processing setup with redis (' + redisConfig.host +
            ':' + redisConfig.port  + ')');
    });
    connection.on('error', function(err){
        logger.error(logSystem, logComponent, logSubCat, 'Redis client had an error: ' + JSON.stringify(err))
    });
    connection.on('end', function(){
        logger.error(logSystem, logComponent, logSubCat, 'Connection to redis database has been ended');
    });

    connection.info(function(error, response){
        if (error){
            logger.error(logSystem, logComponent, logSubCat, 'Redis version check failed');
            return;
        }
        var parts = response.split('\r\n');
        var version;
        var versionString;
        for (var i = 0; i < parts.length; i++){
            if (parts[i].indexOf(':') !== -1){
                var valParts = parts[i].split(':');
                if (valParts[0] === 'redis_version'){
                    versionString = valParts[1];
                    version = parseFloat(versionString);
                    break;
                }
            }
        }
        if (!version){
            logger.error(logSystem, logComponent, logSubCat, 'Could not detect redis version - but be super old or broken');
        }
        else if (version < 2.6){
            logger.error(logSystem, logComponent, logSubCat, "You're using redis version " + versionString + " the minimum required version is 2.6. Follow the damn usage instructions...");
        }
    });

    var mysql_pool = mysql.createPool({
        connectionLimit: 10,
        host:"192.168.1.2",
        user:"unomp",
        password:"unomp",
        database:"crypto"
    });

    this.handleShare = function(isValidShare, isValidBlock, shareData) {

        var redisCommands = [];

        if (!shareData.isSoloMining) {
            if (isValidShare) {
                redisCommands.push(['hincrbyfloat', coin + ':shares:roundCurrent', shareData.worker, shareData.difficulty]);
                redisCommands.push(['hincrby', coin + ':stats', 'validShares', 1]);
            } else {
                redisCommands.push(['hincrby', coin + ':stats', 'invalidShares', 1]);
            }
        }

        /* Stores share diff, worker, and unique value with a score that is the timestamp. Unique value ensures it
           doesn't overwrite an existing entry, and timestamp as score lets us query shares from last X minutes to
           generate hashrate for each worker and pool. */
        var dateNow = Date.now();
        var hashrateData = [ isValidShare ? shareData.difficulty : -shareData.difficulty, shareData.worker, dateNow, shareData.isSoloMining ? 'SOLO' : 'PROP'];
        redisCommands.push(['zadd', coin + ':hashrate', dateNow / 1000 | 0, hashrateData.join(':')]);

        if (isValidBlock){
            if (!shareData.isSoloMining) {
                redisCommands.push(['rename', coin + ':shares:roundCurrent', coin + ':shares:round' + shareData.height]);
            }
            redisCommands.push(['sadd', coin + ':blocksPending', [shareData.blockHash, shareData.txHash, shareData.height, shareData.worker, dateNow / 1000 | 0, shareData.isSoloMining ? 'SOLO' : 'PROP'].join(':')]);
            redisCommands.push(['hincrby', coin + ':stats', 'validBlocks', 1]);
        }
        else if (shareData.blockHash){
            redisCommands.push(['hincrby', coin + ':stats', 'invalidBlocks', 1]);
        }

        connection.multi(redisCommands).exec(function(err, replies){
            if (err)
                logger.error(logSystem, logComponent, logSubCat, 'Error with share processor multi ' + JSON.stringify(err));

            if (isValidBlock && poolConfig.foundBlockWebhook) {
                try {
                    var postData = JSON.stringify({
                        miner: shareData.worker,
                        type: shareData.isSoloMining ? 'SOLO' : 'PROP',
                        height: shareData.height,
                        url: poolConfig.coin.explorer && poolConfig.coin.explorer.blockURL ? poolConfig.coin.explorer.blockURL + shareData.blockHash : ''
                    });

                    var postRequest = http.request(poolConfig.foundBlockWebhook.replace('{coin}', poolConfig.coin.name), {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            'content-length': Buffer.byteLength(postData)
                        }
                    }, function (response) {
                        // Ignore
                    });

                    postRequest.write(postData);

                    postRequest.end();
                } catch (e) {
                    logger.error(logSystem, logComponent, logSubCat, 'Error notifying found block webhook!\n\n' + e.message);
                }
            }
        });
        
        //coin is undefined for merged-mining shares
        if(isValidShare) {
            //add shares directly to MySQL database
            mysql_pool.query("INSERT INTO shares (coin,algo,target_diff,share_diff,block_diff,block_hash) VALUES (?,?,?,?,?,?)",[
                coinSymbol.toUpperCase(),
                algo,
                shareData.difficulty/shareData.shareMultiplier,
                shareData.shareDiff/shareData.shareMultiplier,
                shareData.blockDiff/shareData.shareMultiplier,
                shareData.blockHash
            ], function(err,res,fields) {
                if(err) console.error(err);
            });

            for(var i in auxinfo) {
                var auxblockhash = (auxinfo[i].isValidBlock) ? shareData.blockHashInvalid : null;
                mysql_pool.query("INSERT INTO shares (coin,algo,target_diff,share_diff,block_diff,block_hash) VALUES (?,?,?,?,?,?)",[
                    auxinfo[i].coin.toUpperCase(),
                    algo,
                    shareData.difficulty/shareData.shareMultiplier,
                    shareData.shareDiff/shareData.shareMultiplier,
                    shareData.diff1 / auxinfo[i].target.toNumber(),
                    auxblockhash
                ], function(err,res,fields) {
                    if(err) console.error(err);
                });
            }
        }

    };

};
