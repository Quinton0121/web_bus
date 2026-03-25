const https = require('https');
const puppeteer = require('puppeteer');

(async () => {
    console.log('Fetching token via Puppeteer...');
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    let token = null;

    await page.setRequestInterception(true);
    page.on('request', req => {
        if (req.url().includes('/macauweb/routestation/bus')) {
            token = req.headers()['token'];
        }
        req.continue();
    });

    await page.goto('https://bis.dsat.gov.mo:37812/macauweb/routeLine.html?routeName=11&direction=0&language=zh-tw&ver=3.8.6&routeType=2&fromDzzp=false', { waitUntil: 'networkidle2', timeout: 30000 }).catch(()=>{});
    
    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    await browser.close();

    if (!token) {
        console.log('Failed to get token');
        return;
    }

    console.log('Got token:', token);
    
    // Now request routestation/bus with this token/cookie
    const data = new URLSearchParams({
        action: 'dy',
        routeName: '11',
        dir: '0',
        lang: 'zh-tw',
        routeType: '2',
        device: 'web'
    }).toString();

    const options = {
        hostname: 'bis.dsat.gov.mo',
        port: 37812,
        path: '/macauweb/routestation/bus',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Content-Length': Buffer.byteLength(data),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
            'Origin': 'https://bis.dsat.gov.mo:37812',
            'Referer': 'https://bis.dsat.gov.mo:37812/macauweb/routeLine.html?routeName=11&direction=0&language=zh-tw&ver=3.8.6&routeType=2&fromDzzp=false',
            'Cookie': cookieStr,
            'token': token
        }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        console.log('routestation/bus Response:\n', responseData.substring(0, 1000));
      });
    });
    req.write(data);
    req.end();
})();
