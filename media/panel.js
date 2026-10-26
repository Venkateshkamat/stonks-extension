/* Stonks portfolio webview. Renders the pre-formatted view model posted by the extension and posts actions back.
 * All text goes through textContent / text nodes (no HTML string injection). */
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();

  // Forward uncaught errors to the extension so they are visible (the webview devtools are easy to miss).
  function reportError(message) {
    try {
      vscode.postMessage({ type: 'error', message: String(message) });
    } catch (e) {
      /* nothing else to do */
    }
  }
  window.addEventListener('error', function (e) {
    reportError((e.message || 'error') + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    reportError('Unhandled rejection: ' + (r && r.message ? r.message : r));
  });
  function reportDiag() {
    vscode.postMessage({
      type: 'diag',
      chartLib: typeof Chart !== 'undefined',
      chartRendered: !!chart,
      holdingRows: elHoldings.querySelectorAll('tbody tr:not(.error-row)').length,
    });
  }
  var app = document.getElementById('app');

  /** @type {any} latest PanelModel */
  var model = null;
  /** undefined = nothing received yet, null = loading, object = ChartModel */
  var chartModel;
  var chart = null;

  // ---------- helpers ----------

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k) || props[k] === undefined || props[k] === null) continue;
        if (k === 'class') el.className = props[k];
        else if (k === 'text') el.textContent = props[k];
        else if (k === 'onclick') el.addEventListener('click', props[k]);
        else el.setAttribute(k, props[k]);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === undefined || c === null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    eye: ['M1 8c1.3-2.7 3.7-5 7-5s5.7 2.3 7 5c-1.3 2.7-3.7 5-7 5S2.3 10.7 1 8z', 'M8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z'],
    'eye-off': ['M1 8c1.3-2.7 3.7-5 7-5s5.7 2.3 7 5c-1.3 2.7-3.7 5-7 5S2.3 10.7 1 8z', 'M8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z', 'M2.5 2.5l11 11'],
    refresh: ['M13.2 8a5.2 5.2 0 1 1-1.6-3.7', 'M13.5 2.5v3.3h-3.3'],
    plus: ['M8 3v10', 'M3 8h10'],
    edit: ['M2.5 13.5l.7-3.1 7.6-7.6a1.2 1.2 0 0 1 1.7 0l.6.6a1.2 1.2 0 0 1 0 1.7l-7.6 7.6z', 'M9.6 4l2.4 2.4'],
    trash: ['M3 4.5h10', 'M6 4.5V3h4v1.5', 'M4.4 4.5l.6 8.5h6l.6-8.5', 'M7 7v4', 'M9 7v4'],
  };

  function icon(name) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    ICONS[name].forEach(function (d) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  function iconButton(name, label, onclick, extraClass) {
    return h('button', { class: 'icon-btn' + (extraClass ? ' ' + extraClass : ''), type: 'button', title: label, 'aria-label': label, onclick: onclick }, icon(name));
  }

  function act(action, id) {
    var msg = { type: 'action', action: action };
    if (id) msg.id = id;
    vscode.postMessage(msg);
  }

  function cell(c, extraClass) {
    var cls = [c.tone || '', extraClass || ''].join(' ').trim();
    return h('span', { class: cls || undefined, title: c.title, text: c.text });
  }

  // ---------- skeleton ----------

  var elTop = h('div', { class: 'topbar' });
  var elStatus = h('div');
  var elWarnings = h('ul', { class: 'warnings' });
  var elHoldings = h('section');
  var elChartSection = h('section');
  var elIndices = h('section');

  var chartTitle = h('h2', { text: '30-day chart' });
  var chartCanvas = h('canvas', { role: 'img', 'aria-label': '30-day portfolio chart' });
  var chartMsg = h('div', { class: 'chart-msg', text: 'Loading chart...' });
  var chartErrors = h('div', { class: 'chart-errors' });
  var chartBox = h('div', { class: 'chart-box' }, chartCanvas, chartMsg);
  elChartSection.appendChild(chartTitle);
  elChartSection.appendChild(chartBox);
  elChartSection.appendChild(chartErrors);

  app.appendChild(elTop);
  app.appendChild(elStatus);
  app.appendChild(elWarnings);
  app.appendChild(elHoldings);
  app.appendChild(elChartSection);
  app.appendChild(elIndices);

  // ---------- rendering ----------

  function renderTop() {
    var meta = h('div', { class: 'meta' });
    var parts = ['Base currency ' + model.baseCurrency];
    if (model.loading) parts.push('Refreshing...');
    else if (model.updated) parts.push('Updated ' + model.updated);
    if (model.dataSource) parts.push('Data: ' + model.dataSource);
    if (model.fx) parts.push(model.fx);
    parts.forEach(function (p, i) {
      if (i > 0) meta.appendChild(h('span', { class: 'sep', text: '·' }));
      meta.appendChild(document.createTextNode(p));
    });

    var hideLabel = model.hideAmounts ? 'Show amounts' : 'Hide amounts';
    var toolbar = h(
      'div',
      { class: 'toolbar' },
      iconButton(model.hideAmounts ? 'eye' : 'eye-off', hideLabel, function () { act('toggleHide'); }, model.hideAmounts ? 'on' : ''),
      iconButton('refresh', 'Refresh', function () { act('refresh'); }, model.loading ? 'spin' : ''),
      h('button', { class: 'btn', type: 'button', onclick: function () { act('add'); } }, icon('plus'), 'Add holding'),
    );
    toolbar.firstChild.setAttribute('aria-pressed', model.hideAmounts ? 'true' : 'false');

    elTop.replaceChildren(h('div', null, h('h1', { text: 'Stonks' }), meta), toolbar);
  }

  function renderStatus() {
    var kids = [];
    if (model.empty) {
      // no summary on the empty state
    } else if (model.cards.length > 0) {
      var cards = h('div', { class: 'cards' });
      model.cards.forEach(function (c) {
        cards.appendChild(
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'label', text: c.label }),
            h('div', { class: 'main' }, cell(c.main)),
            c.sub ? h('div', { class: 'sub' }, cell(c.sub)) : null,
          ),
        );
      });
      kids.push(cards);
    } else if (model.statusMessage) {
      kids.push(h('div', { class: 'status-msg', text: model.statusMessage }));
    }
    elStatus.replaceChildren.apply(elStatus, kids);

    elWarnings.replaceChildren.apply(
      elWarnings,
      model.warnings.map(function (w) { return h('li', { text: w }); }),
    );
  }

  function renderHoldings() {
    if (model.empty) {
      elHoldings.replaceChildren(
        h(
          'div',
          { class: 'empty' },
          h('div', { class: 'title', text: 'No holdings yet' }),
          h('div', { class: 'hint', text: 'Track your stocks and crypto: add a holding to see your profit and loss.' }),
          h('button', { class: 'btn large', type: 'button', onclick: function () { act('add'); } }, icon('plus'), 'Add your first holding'),
        ),
      );
      return;
    }
    var headRow = h('tr');
    model.columns.forEach(function (c) {
      headRow.appendChild(h('th', { class: c.align === 'right' ? 'right' : undefined, scope: 'col', text: c.label }));
    });
    headRow.appendChild(h('th', { scope: 'col', 'aria-label': 'Actions' }));

    var tbody = h('tbody');
    var span = model.columns.length + 1;
    model.rows.forEach(function (r) {
      var tr = h('tr', { class: r.error ? 'has-error' : undefined });
      r.cells.forEach(function (c, i) {
        var col = model.columns[i];
        var cls = [col && col.align === 'right' ? 'right' : '', i === 0 ? 'symbol' : ''].join(' ').trim();
        tr.appendChild(h('td', { class: cls || undefined }, cell(c)));
      });
      tr.appendChild(
        h(
          'td',
          { class: 'actions' },
          iconButton('edit', 'Edit ' + r.label, function () { act('edit', r.id); }),
          iconButton('trash', 'Remove ' + r.label, function () { act('remove', r.id); }, 'danger'),
        ),
      );
      tbody.appendChild(tr);
      if (r.error) {
        tbody.appendChild(h('tr', { class: 'error-row' }, h('td', { colspan: String(span), text: '⚠ ' + r.label + ': ' + r.error })));
      }
    });

    elHoldings.replaceChildren(
      h('h2', { text: 'Holdings' }),
      h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, headRow), tbody)),
    );
  }

  function renderIndices() {
    var kids = [h('h2', { text: 'Markets' })];
    if (model.indices.length === 0) {
      kids.push(h('div', { class: 'status-msg', text: model.indicesLoading ? 'Loading indices...' : 'No index data.' }));
    } else {
      var groups = h('div', { class: 'index-groups' });
      model.indices.forEach(function (g) {
        var tbody = h('tbody');
        g.items.forEach(function (it) {
          tbody.appendChild(
            h(
              'tr',
              null,
              h('td', { class: 'symbol', text: it.name }),
              h('td', { class: 'right' }, cell(it.level)),
              h('td', { class: 'right' }, cell(it.change)),
              h('td', { class: 'right' }, cell(it.percent)),
            ),
          );
          if (it.error) {
            tbody.appendChild(h('tr', { class: 'error-row' }, h('td', { colspan: '4', text: '⚠ ' + it.name + ': ' + it.error })));
          }
        });
        groups.appendChild(
          h(
            'div',
            null,
            h('h3', { text: g.region }),
            h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                null,
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { text: 'Index' }),
                    h('th', { class: 'right', text: 'Level' }),
                    h('th', { class: 'right', text: 'Change' }),
                    h('th', { class: 'right', text: 'Change %' }),
                  ),
                ),
                tbody,
              ),
            ),
          ),
        );
      });
      kids.push(groups);
    }
    elIndices.replaceChildren.apply(elIndices, kids);
  }

  function render() {
    renderTop();
    renderStatus();
    renderHoldings();
    renderIndices();
    renderChartVisibility();
  }

  // ---------- chart ----------

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    v = v ? v.trim() : '';
    return v || fallback;
  }

  /** Normalises any CSS colour to rgba(...) with the given alpha (via a 1x1 canvas). */
  function withAlpha(color, alpha) {
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      var d = ctx.getImageData(0, 0, 1, 1).data;
      return 'rgba(' + d[0] + ', ' + d[1] + ', ' + d[2] + ', ' + alpha + ')';
    } catch (e) {
      return color;
    }
  }

  function destroyChart() {
    if (chart) {
      chart.destroy();
      chart = null;
    }
  }

  function renderChartVisibility() {
    var showSection = model && !model.empty;
    elChartSection.classList.toggle('hidden', !showSection);
    if (showSection && !chart && chartModel === undefined) setChartMessage('Loading chart...');
  }

  function setChartMessage(text) {
    chartMsg.textContent = text || '';
    chartMsg.classList.toggle('hidden', !text);
    chartCanvas.classList.toggle('hidden', !!text);
  }

  function renderChart() {
    destroyChart();
    chartErrors.textContent = '';
    if (chartModel === undefined || chartModel === null) {
      chartTitle.textContent = '30-day chart';
      setChartMessage('Loading chart...');
      return;
    }
    var m = chartModel;
    chartTitle.textContent = m.title;
    if (m.errors && m.errors.length > 0) chartErrors.textContent = '⚠ ' + m.errors.join(' · ');
    if (m.message || m.values.length === 0) {
      setChartMessage(m.message || 'No price history available.');
      return;
    }
    if (typeof Chart === 'undefined') {
      setChartMessage('Chart library failed to load.');
      return;
    }
    setChartMessage('');

    var lineColor = m.trend === 'gain' ? cssVar('--gain', '#3fb950') : m.trend === 'loss' ? cssVar('--loss', '#f85149') : cssVar('--accent', '#3794ff');
    var textColor = cssVar('--vscode-descriptionForeground', cssVar('--vscode-foreground', '#999'));
    var gridColor = withAlpha(cssVar('--vscode-foreground', '#888'), 0.12);
    var tipBg = cssVar('--vscode-editorHoverWidget-background', '#252526');
    var tipFg = cssVar('--vscode-editorHoverWidget-foreground', cssVar('--vscode-foreground', '#ccc'));
    var tipBorder = cssVar('--vscode-editorHoverWidget-border', cssVar('--vscode-panel-border', '#454545'));

    var fmtCompact;
    if (m.axis.kind === 'money') {
      try {
        fmtCompact = new Intl.NumberFormat(m.axis.locale || 'en-US', { notation: 'compact', maximumFractionDigits: 2 });
      } catch (e) {
        fmtCompact = new Intl.NumberFormat('en-US');
      }
    }
    function tick(v) {
      if (m.axis.kind === 'percent') return (v > 0 ? '+' : '') + Number(v.toFixed(2)) + '%';
      return (m.axis.symbol || '') + fmtCompact.format(v);
    }

    var ctx = chartCanvas.getContext('2d');
    var gradient = ctx.createLinearGradient(0, 0, 0, 260);
    gradient.addColorStop(0, withAlpha(lineColor, 0.28));
    gradient.addColorStop(1, withAlpha(lineColor, 0));

    chart = new Chart(chartCanvas, {
      type: 'line',
      data: {
        labels: m.labels,
        datasets: [
          {
            data: m.values,
            borderColor: lineColor,
            backgroundColor: gradient,
            fill: true,
            borderWidth: 2,
            tension: 0.25,
            pointRadius: m.values.length <= 2 ? 3 : 0,
            pointHoverRadius: 4,
            pointBackgroundColor: lineColor,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: tipBg,
            titleColor: tipFg,
            bodyColor: tipFg,
            borderColor: tipBorder,
            borderWidth: 1,
            displayColors: false,
            callbacks: {
              title: function (items) { return m.tooltipTitles[items[0].dataIndex]; },
              label: function (item) { return m.tooltips[item.dataIndex]; },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: textColor, maxTicksLimit: 8, maxRotation: 0 }, border: { color: gridColor } },
          y: { grid: { color: gridColor }, border: { display: false }, ticks: { color: textColor, callback: tick, maxTicksLimit: 6 } },
        },
      },
    });
  }

  // ---------- wiring ----------

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state') {
      model = msg.model;
      render();
    } else if (msg.type === 'history') {
      chartModel = msg.chart;
      renderChart();
      reportDiag();
    }
  });

  // Re-apply theme colours to the chart when VS Code switches themes (it swaps classes on <body>).
  new MutationObserver(function () {
    if (chart && chartModel) renderChart();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  vscode.postMessage({ type: 'ready' });
  reportDiag();
})();
