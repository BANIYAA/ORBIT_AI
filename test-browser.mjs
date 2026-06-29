import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  page.on('response', response => {
    if (response.status() >= 400) {
      console.log('RESPONSE ERROR:', response.status(), response.url());
    }
  });

  // Simulate
  const response = await fetch('http://localhost:3000/src/main.tsx');
  console.log("Main tsx status:", response.status);
  try {
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle0', timeout: 15000 });
    const content = await page.content();
    console.log("DOM Content contains Orbit AI:", content.includes('Orbit AI'));
    console.log("DOM Content contains root content:", content.includes('id="orbit-top-navigation"'));
  } catch (err) {
    console.log("Could not load page:", err);
  }

  await browser.close();
})();
