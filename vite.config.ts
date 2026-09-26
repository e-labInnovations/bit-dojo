import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import { CHAPTERS, LEVELS } from './src/core/levels';

// Public URL of the deployed site. Absolute URLs are needed for canonical, Open Graph and the sitemap.
const SITE_URL = (process.env.SITE_URL ?? 'https://bit-dojo.elabins.com/').replace(/\/?$/, '/');

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = (html: string) => html.replace(/<[^>]+>/g, '');

// Static, crawlable description of the app. The app replaces it as soon as JS runs.
function seoContent(): string {
  let n = 0;
  const chapters = CHAPTERS.map((ch) => {
    const items = LEVELS.filter((l) => l.chapter === ch)
      .map((l) => `<li><a href="#/level/${l.id}">${++n}. ${esc(l.title)}</a> — ${esc(strip(l.goal))}</li>`)
      .join('');
    return `<h3>${esc(ch)}</h3><ol>${items}</ol>`;
  }).join('');
  return `<div class="seo-fallback">
  <h1>bit-dojo: learn bitwise register tricks on a CH32V003</h1>
  <p>A free, interactive game for learning the bitwise operations embedded C is built on. Write real register code, such as <code>GPIOC-&gt;CFGLR |= (GPIO_Speed_10MHz | GPIO_CNF_OUT_PP) &lt;&lt; (4*1);</code>, against a simulated CH32V003 RISC-V microcontroller, and see every bit change.</p>
  <h2>What you practise</h2>
  <ul>
    <li>Setting, clearing, toggling and testing bits with <code>|=</code>, <code>&amp;= ~</code>, <code>^=</code> and <code>&amp;</code></li>
    <li>Writing and reading multi-bit register fields with masks and shifts</li>
    <li>Real CH32V003 registers: RCC clock enables, GPIO CFGLR, OUTDR, INDR and BSHR</li>
    <li>Classic embedded C bugs: clobbering with <code>=</code>, operator precedence, signed shifts and undefined behaviour</li>
    <li>An animated step-by-step visualizer that shows how every operator works in binary</li>
  </ul>
  <h2>${LEVELS.length} levels in ${CHAPTERS.length} chapters</h2>
  ${chapters}
  <p><a href="#/sandbox">Open the sandbox</a> to experiment with a whole simulated chip.</p>
  <noscript><p><strong>bit-dojo needs JavaScript to run the simulator.</strong></p></noscript>
</div>`;
}

function seo(): Plugin {
  return {
    name: 'bit-dojo-seo',
    transformIndexHtml(html) {
      return html.replaceAll('%SITE_URL%', SITE_URL).replaceAll('%APP_VERSION%', VERSION).replace('<!--seo-content-->', seoContent());
    },
    generateBundle() {
      const today = new Date().toISOString().slice(0, 10);
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`,
      });
    },
  };
}

// Relative base so the build works under /<repo>/ on GitHub Pages and from any static host.
export default defineConfig({
  base: './',
  plugins: [seo()],
});
