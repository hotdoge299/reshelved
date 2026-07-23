const bcrypt = require('bcryptjs');

const passcode = process.argv[2];
if (!passcode) {
  console.error('Usage: node generate-hash.js "your-real-passcode"');
  process.exit(1);
}

bcrypt.hash(passcode, 12).then(hash => {
  console.log(hash);
});
