import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToMd, htmlToText, imgSources } from './html';

describe('htmlToText', () => {
  it.each([
    ['<b>a</b>&nbsp;b', 'a b'],
    ['a<br>b<br/>c', 'a\nb\nc'],
    ['<div>a</div><div>b</div>', 'a\nb'],
    ['x &amp; y &lt; z &gt; &quot;q&quot; &#39;s&#39; &#x41;', 'x & y < z > "q" \'s\' A'],
    ['<a href="http://x">texto</a> <img src="a.png"> fim', 'texto fim'],
    ['[[r::inner]] e [[solo]]', 'inner e solo'],
    ['[sound:a.mp3]oi<!-- c --><style>p{}</style>', 'oi'],
    ['&unknown; &#99999999;', '&unknown; &#99999999;'],
    ['a\n\n\n\nb   c', 'a\n\nb c'],
  ])('%j -> %j', (i, o) => expect(htmlToText(i)).toBe(o));
  it('decodeEntities handles nbsp numeric', () => expect(decodeEntities('a&#160;b')).toBe('a b'));
});

describe('imgSources', () => {
  it('collects src in order, skips urls and duplicates', () => {
    expect(imgSources(`<img src="a.png"><img alt="x" src='b c.jpg'><img src=d.gif><img src="https://x/y.png"><img src="a.png">`)).toEqual(['a.png', 'b c.jpg', 'd.gif']);
  });
});

describe('htmlToMd', () => {
  it.each([
    ['<b>a</b> <strong>b</strong>', '**a b**'], // adjacent runs merge (same rendering)
    ['<i>a</i> <em>b</em> <u>c</u> x<sup>2</sup>H<sub>2</sub>O', '*a b* c x2H2O'],
    ['<b><i>x</i></b> <i><b>y</b></i>', '**x** *y*'], // renderer cannot nest: outermost wins
    ['<b></b>a<i> </i>b', 'a b'],
    ['<b>aberto<br>fechado</b>', 'aberto\nfechado'], // emphasis crossing a line is dropped, never left dangling
    ['a * b _c_ 2*3', 'a ∗ b _c_ 2∗3'],
    ['<code>x</code>', '`x`'],
    ['a<br>b<div>c</div><div>d</div>', 'a\nb\nc\nd'],
    ['<div>a<br></div>', 'a'],
    ['<ul><li>um</li><li>dois</li></ul>', '- um\n- dois'],
    ['antes<ol><li>um</li><li><b>dois</b></li></ol>depois', 'antes\n1. um\n2. **dois**\ndepois'],
    ['<a href="https://x.com/a?b=1&amp;c=2">site</a>', '[site](https://x.com/a?b=1&c=2)'],
    ['<a href="https://x.com/a(b)">s</a>', '[s](https://x.com/a%28b%29)'],
    ['<a href="javascript:alert(1)">x</a> <a href="data:text/html,1">y</a> <a href="/rel">z</a> <a>w</a>', 'x y z w'],
    ['<a href="https://x.com"><img src="a.png"></a>ok', 'ok'],
    ['<a href="https://x.com">[a]</a>', '[(a)](https://x.com)'],
    ['<a href="https://x.com"><b>bold</b></a>', '[bold](https://x.com)'],
    ['<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>', 'A · B\n1 · 2'],
    ['[sound:a.mp3]oi &nbsp;&nbsp; &nbsp;fim', 'oi fim'],
    ['\\(a &lt; b\\) e \\[x^2\\]', '\\(a < b\\) e \\[x^2\\]'],
    ['<script>x()</script><style>p{}</style><!-- c -->t<span style="color:red">v</span>', 'tv'],
    ['&lt;b&gt;não é tag&lt;/b&gt;', '<b>não é tag</b>'],
    ['x\uE000y\uE003z', 'xyz'],
    ['[...] e [dica] ficam', '[...] e [dica] ficam'],
  ])('%j -> %j', (i, o) => expect(htmlToMd(i)).toBe(o));
});
