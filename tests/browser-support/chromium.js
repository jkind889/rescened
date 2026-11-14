// Shared by the explicit synthetic browser suite. Capture before fixture cleanup.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
let sequence = 0;
module.exports.chromium = {
  async launch(options) {
    const browser = await chromium.launch(options);
    const contexts = new Set();
    const originalContext = browser.newContext.bind(browser);
    browser.newContext = async settings => {
      const context = await originalContext({ ...settings, serviceWorkers: 'block' });
      contexts.add(context);
      const id = `${path.basename(process.argv[1], '.test.js')}-${++sequence}`;
      const directory = process.env.FRONTEND_BROWSER_ARTIFACT_DIR;
      let pageSequence = 0;
      if (directory) {
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        const captures = new Map();
        context.on('page', page => {
          const index = pageSequence++;
          const capture = async () => {
            if (page.isClosed()) return;
            await fs.mkdir(directory, { recursive: true });
            await page.screenshot({ path: path.join(directory, `${id}-${index}.png`), fullPage: true, timeout: 5000 });
            await fs.writeFile(path.join(directory, `${id}-${index}.html`), await page.content());
          };
          captures.set(page, capture);
          const close = page.close.bind(page);
          page.close = async () => { try { await capture(); } finally { await close(); } };
        });
        const close = context.close.bind(context);
        context.close = async () => {
          if (!contexts.delete(context)) return;
          try {
            for (const capture of captures.values()) await capture();
            await context.tracing.stop({ path: path.join(directory, `${id}.zip`) });
          } finally { await close(); }
        };
      }
      // Page-specific synthetic routes take precedence. Other requests must
      // stay on the exact loopback origin opened for this fixture.
      let origin;
      await context.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if (!origin && request.isNavigationRequest() && ['127.0.0.1', 'localhost'].includes(url.hostname)) origin = url.origin;
        return url.origin === origin ? route.continue() : route.abort('blockedbyclient');
      });
      return context;
    };
    browser.newPage = async settings => (await browser.newContext(settings)).newPage();
    const close = browser.close.bind(browser);
    browser.close = async () => {
      try {
        const results = await Promise.allSettled([...contexts].map(context => context.close()));
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      } finally { await close(); }
    };
    return browser;
  },
};
