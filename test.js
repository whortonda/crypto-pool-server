multiHashing = require("./node_modules/multi-hashing");
var b = Buffer.from("00000020e22a826aa19074347d50f5dc5c5ff404308c9e2d8a4364cb3c9b14b17eb428e7d7e323953b4ff6f84d89a8aaa085f683d8bb82495b1611670d3ad8df7c7c03ec6a8408621c3c011a6e855059","hex");
console.log(multiHashing.scrypt(b,1024,1));
