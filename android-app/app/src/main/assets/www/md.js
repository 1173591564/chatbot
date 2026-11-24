/* ================= Markdown 渲染（Android 版，精简但完整） ================= */
(function (global) {
  'use strict';

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ESC[c]; }); }

  var KW = ('const let var function return if else for while do break continue class extends new this super ' +
    'import from export default async await try catch finally throw typeof instanceof in of delete void yield ' +
    'static get set switch case default null undefined true false NaN Infinity ' +
    'def elif except lambda pass raise with as assert del global nonlocal and or not is None True False self ' +
    'public private protected interface implements enum package struct func go defer chan select map fn mut ' +
    'impl trait pub use mod match where loop unsafe ref echo sudo npm node python pip git docker').split(' ');

  var KW_SET = {};
  KW.forEach(function (k) { KW_SET[k] = 1; });

  var HL_RE = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\$]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;

  function highlight(code, lang) {
    lang = (lang || '').toLowerCase();
    if (/html|xml|svg/.test(lang)) {
      return esc(code)
        .replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="tok-f">$2</span>')
        .replace(/([\w-]+)=(&quot;|")/g, '<span class="tok-n">$1</span>=$2');
    }
    var out = [], last = 0, m;
    HL_RE.lastIndex = 0;
    while ((m = HL_RE.exec(code))) {
      if (m.index > last) out.push(esc(code.slice(last, m.index)));
      if (m[1]) out.push('<span class="tok-c">' + esc(m[1]) + '</span>');
      else if (m[2]) out.push('<span class="tok-s">' + esc(m[2]) + '</span>');
      else if (m[3]) out.push('<span class="tok-n">' + esc(m[3]) + '</span>');
      else if (m[4]) {
        var w = m[4], cls = KW_SET[w] ? 'tok-k' : (/^[A-Z]/.test(w) ? 'tok-f' : '');
        out.push(cls ? '<span class="' + cls + '">' + esc(w) + '</span>' : esc(w));
      }
      last = m.index + m[0].length;
    }
    if (last < code.length) out.push(esc(code.slice(last)));
    return out.join('');
  }

  function sanitizeUrl(u) {
    u = String(u || '').trim().replace(/&amp;/g, '&');
    if (/^(https?:|mailto:)/i.test(u)) return esc(u);
    if (/^[./#]/.test(u)) return esc(u);
    return '';
  }

  function inline(text) {
    var codes = [];
    var s = String(text).replace(/`([^`\n]+)`/g, function (_, c) {
      codes.push('<code>' + esc(c) + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, alt, url) {
      var u = sanitizeUrl(url);
      return u ? '<img src="' + u + '" alt="' + alt + '" style="max-width:100%;border-radius:8px">' : alt;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, label, url) {
      var u = sanitizeUrl(url);
      return u ? '<a href="' + u + '" target="_blank" rel="noopener">' + label + '</a>' : label;
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)）]+)/g, function (_, pre, url) {
      var trimmed = url.replace(/[.,;:!?]+$/, '');
      var tail = url.slice(trimmed.length);
      var u = sanitizeUrl(trimmed);
      return u ? pre + '<a href="' + u + '" target="_blank" rel="noopener">' + trimmed + '</a>' + tail : pre + url;
    });
    s = s
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__([^_]+)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return codes[Number(i)] || ''; });
    return s;
  }

  function buildList(items) {
    var out = '', stack = [];
    items.forEach(function (it) {
      var tag = it.ordered ? 'ol' : 'ul';
      if (!stack.length) { stack.push({ indent: it.indent, tag: tag }); out += '<' + tag + '>'; }
      else if (it.indent > stack[stack.length - 1].indent + 1) {
        stack.push({ indent: it.indent, tag: tag }); out += '<' + tag + '>';
      } else {
        while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) {
          var p = stack.pop(); out += '</li></' + p.tag + '>';
        }
        var top = stack[stack.length - 1];
        if (top.tag !== tag) { out += '</li></' + top.tag + '>'; stack.pop(); stack.push({ indent: it.indent, tag: tag }); out += '<' + tag + '>'; }
        else out += '</li>';
      }
      out += '<li>' + inline(it.text);
    });
    while (stack.length) out += '</li></' + stack.pop().tag + '>';
    return out;
  }

  function render(src) {
    var lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    var html = [], i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // 代码块
      var fence = /^\s*(```|~~~)(.*)$/.exec(line);
      if (fence) {
        var marker = fence[1], lang = (fence[2] || '').trim().split(/\s+/)[0] || '';
        var buf = [];
        i++;
        var closeRe = new RegExp('^\\s*' + marker + '\\s*$');
        while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html.push('<pre><div class="code-head"><span>' + esc(lang || 'text') + '</span>' +
          '<button class="copy-code" type="button">复制</button></div>' +
          '<code>' + highlight(buf.join('\n'), lang) + '</code></pre>');
        continue;
      }

      if (!line.trim()) { i++; continue; }

      // 分割线
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html.push('<hr>'); i++; continue; }

      // 标题
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { html.push('<h' + h[1].length + '>' + inline(h[2].trim()) + '</h' + h[1].length + '>'); i++; continue; }

      // 引用
      if (/^\s*>/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html.push('<blockquote>' + render(q.join('\n')) + '</blockquote>');
        continue;
      }

      // 表格
      if (line.indexOf('|') >= 0 && i + 1 < lines.length &&
          /^\s*\|?[\s:-]*-[\s|:-]*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
        var parseRow = function (l) {
          return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
        };
        var head = parseRow(line);
        var align = parseRow(lines[i + 1]).map(function (c) {
          return /^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : '';
        });
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) { rows.push(parseRow(lines[i])); i++; }
        var th = head.map(function (c, k) {
          return '<th' + (align[k] ? ' style="text-align:' + align[k] + '"' : '') + '>' + inline(c) + '</th>';
        }).join('');
        var tb = rows.map(function (r) {
          return '<tr>' + r.map(function (c, k) {
            return '<td' + (align[k] ? ' style="text-align:' + align[k] + '"' : '') + '>' + inline(c) + '</td>';
          }).join('') + '</tr>';
        }).join('');
        html.push('<div class="table-wrap"><table><thead><tr>' + th + '</tr></thead><tbody>' + tb + '</tbody></table></div>');
        continue;
      }

      // 列表
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          var mm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          items.push({ indent: mm[1].replace(/\t/g, '    ').length, ordered: /\d/.test(mm[2]), text: mm[3] });
          i++;
          while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && /^\s{2,}/.test(lines[i])) {
            items[items.length - 1].text += ' ' + lines[i].trim();
            i++;
          }
        }
        html.push(buildList(items));
        continue;
      }

      // 段落
      var para = [];
      while (i < lines.length && lines[i].trim() &&
             !/^\s*(```|~~~)/.test(lines[i]) &&
             !/^(#{1,6})\s/.test(lines[i]) &&
             !/^\s*>/.test(lines[i]) &&
             !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
             !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      if (para.length) html.push('<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
      else i++;
    }
    return html.join('');
  }

  global.MD = { render: render, esc: esc };
})(window);
