import { MACROS, hex } from '../core/chip';

const macroRows = (group: string) =>
  Object.entries(MACROS)
    .filter(([, m]) => m.group === group)
    .map(([name, m]) => `<tr><td><code>${name}</code></td><td><code>${hex(m.value, group === 'RCC' ? 8 : 1)}</code></td></tr>`)
    .join('');

export const CHEATSHEET = `
<h2>The five idioms</h2>
<table class="cs">
  <tr><th>Set bit n</th><td><code>reg |= (1u &lt;&lt; n);</code></td></tr>
  <tr><th>Clear bit n</th><td><code>reg &amp;= ~(1u &lt;&lt; n);</code></td></tr>
  <tr><th>Toggle bit n</th><td><code>reg ^= (1u &lt;&lt; n);</code></td></tr>
  <tr><th>Test bit n</th><td><code>if (reg &amp; (1u &lt;&lt; n))</code></td></tr>
  <tr><th>Write field</th><td><code>reg = (reg &amp; ~(mask &lt;&lt; lsb)) | (val &lt;&lt; lsb);</code></td></tr>
  <tr><th>Read field</th><td><code>val = (reg &gt;&gt; lsb) &amp; mask;</code></td></tr>
</table>

<h2>GPIO on CH32V003</h2>
<table class="cs">
  <tr><th>Clock</th><td><code>RCC-&gt;APB2PCENR |= RCC_APB2Periph_GPIOC;</code> — without it, GPIOC ignores you</td></tr>
  <tr><th>Pin n config</th><td><code>CFGLR</code> bits <code>4n+3…4n</code>: <code>CNF[1:0] MODE[1:0]</code></td></tr>
  <tr><th>Set / clear pin</th><td><code>BSHR = 1 &lt;&lt; n</code> / <code>BSHR = 1 &lt;&lt; (16+n)</code> — one store, no read</td></tr>
  <tr><th>Read pin</th><td><code>INDR &amp; (1 &lt;&lt; n)</code></td></tr>
  <tr><th>Pull-up</th><td><code>GPIO_CNF_IN_PUPD</code> + <code>OUTDR</code> bit = 1 (0 = pull-down)</td></tr>
</table>

<div class="cs-cols">
  <div>
    <h3>MODE (speed)</h3>
    <table class="cs cs-small">${macroRows('MODE')}</table>
    <h3>CNF (already shifted by 2)</h3>
    <table class="cs cs-small">${macroRows('CNF')}</table>
  </div>
  <div>
    <h3>RCC clock bits</h3>
    <table class="cs cs-small">${macroRows('RCC')}</table>
  </div>
</div>

<h2>Precedence (tightest first)</h2>
<ol class="prec">
  <li><code>~ ! -</code> <code>(cast)</code></li>
  <li><code>* / %</code></li>
  <li><code>+ -</code></li>
  <li><code>&lt;&lt; &gt;&gt;</code> <span class="muted">— looser than +, so <code>1 &lt;&lt; 4+1</code> is <code>1 &lt;&lt; 5</code></span></li>
  <li><code>&lt; &lt;= &gt; &gt;=</code></li>
  <li><code>== !=</code></li>
  <li><code>&amp;</code> <span class="muted">— looser than ==. Always bracket: <code>(x &amp; m) == 0</code></span></li>
  <li><code>^</code></li>
  <li><code>|</code></li>
  <li><code>&amp;&amp;</code>, then <code>||</code>, then <code>?:</code>, then <code>= |= &amp;= …</code></li>
</ol>
<p class="muted">When in doubt, add parentheses. Nobody ever got fired for <code>((a) &amp; (b))</code>.</p>
`;
