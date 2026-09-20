const { spawn, exec } = require('child_process');
const path = require('path');

console.log('>>> [1/3] Bắt đầu kết nối Cloudflare OAuth...');

const loginProc = spawn('npx.cmd', ['wrangler', 'login'], {
    cwd: __dirname,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe']
});

let browserOpened = false;

loginProc.stdout.on('data', (data) => {
    const text = data.toString();
    console.log(text);

    const match = text.match(/https:\/\/dash\.cloudflare\.com\/oauth2\/auth\S+/);
    if (match && !browserOpened) {
        browserOpened = true;
        const url = match[0];
        console.log('>>> [2/3] Đang tự động mở Google Chrome trực tiếp đến trang ủy quyền...');
        exec(`start "" "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "${url}"`, (err) => {
            if (err) console.error('Lỗi mở Chrome:', err);
            else console.log('>>> Chrome đã bật tab Cloudflare! Vui lòng bấm "Allow" trên trình duyệt.');
        });
    }
});

loginProc.stderr.on('data', (data) => {
    console.error(data.toString());
});

loginProc.on('close', (code) => {
    if (code === 0) {
        console.log('>>> [3/3] Đăng nhập Cloudflare thành công! Đang tự động deploy worker.js...');
        const deployProc = spawn('npx.cmd', ['wrangler', 'deploy'], {
            cwd: __dirname,
            shell: true,
            stdio: 'inherit'
        });
        deployProc.on('close', (dCode) => {
            if (dCode === 0) {
                console.log('>>> HOÀN TẤT 100%! ĐÃ DEPLOY XONG WORKER LÊN CLOUDFLARE!');
            } else {
                console.error('>>> Deploy thất bại với mã lỗi:', dCode);
            }
        });
    } else {
        console.error('>>> Quá trình login kết thúc với mã:', code);
    }
});
