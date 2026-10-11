const bcrypt = require('bcryptjs');
const { createUser, getUserByEmail } = require('../src/db');

const demos = [
  { name: 'An Nguyễn', email: 'demo1@demo.com', password: 'demo1234' },
  { name: 'Bình Trần', email: 'demo2@demo.com', password: 'demo1234' },
  { name: 'Chi Phạm', email: 'demo3@demo.com', password: 'demo1234' },
];

for (const d of demos) {
  if (getUserByEmail(d.email)) {
    console.log(`- ${d.email} đã tồn tại`);
    continue;
  }
  createUser(d.name, d.email, bcrypt.hashSync(d.password, 10));
  console.log(`+ Đã tạo ${d.email} / ${d.password}`);
}
console.log('\nĐăng nhập bằng các tài khoản demo trên để test chat 2 người.');
