#!/usr/bin/env node
/* make-slim-catalog — build the bundled table-definition module.
 *
 *   node tools/make-slim-catalog.js
 *
 * Extracts just the tables the patchers need (Main VE, Main Spark Advance)
 * from the full catalog and writes js/bundled-catalog.js as
 * P66.BUNDLED_CATALOG. The easy-mode wizard uses this so users never
 * have to find or upload an XDF — the definitions ship with the app.
 *
 * Table definitions derived from Robert Saar's P66 V6 XDF; the app
 * credits him in the UI.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

var WANT = ['Main VE', 'Main Spark Advance', 'Power Enrichment Target AFR'];

var full = JSON.parse(fs.readFileSync(path.join(ROOT, 'defs', 'xdf', 'p66-v6-34l.catalog.json'), 'utf8'));

function slimTable(t) {
  function slimAxis(a) {
    if (!a) return null;
    return { units: a.units || '', labels: a.labels || [] };
  }
  return {
    title: t.title,
    address: t.address,
    rows: t.rows,
    cols: t.cols,
    elementSizeBits: t.elementSizeBits,
    xAxis: slimAxis(t.xAxis),
    yAxis: slimAxis(t.yAxis),
    zAxis: { units: (t.zAxis && t.zAxis.units) || '', equation: (t.zAxis && t.zAxis.equation) || '' }
  };
}

var tables = [];
WANT.forEach(function (name) {
  var t = full.tables.filter(function (x) { return x.title === name; })[0];
  if (!t) throw new Error('table not found in catalog: ' + name);
  tables.push(slimTable(t));
});

var slim = {
  deftitle: full.deftitle,
  source: 'Robert Saar P66 V6 XDF (slim extract)',
  tables: tables,
  audit: full.audit || null
};

var lines = [
  '/* P66 bundled table definitions — GENERATED, do not edit.',
  ' * Built by tools/make-slim-catalog.js from defs/xdf/p66-v6-34l.catalog.json.',
  ' * Contains only the tables the patchers need: Main VE, Main Spark Advance, Power Enrichment Target AFR.',
  ' * Table definitions derived from Robert Saar\'s P66 V6 XDF.',
  ' */',
  '(function (global) {',
  '  "use strict";',
  '  var P66 = (global.P66 = global.P66 || {});',
  '  P66.BUNDLED_CATALOG = ' + JSON.stringify(slim) + ';',
  '})(typeof window !== "undefined" ? window : global);',
  ''
];

fs.writeFileSync(path.join(ROOT, 'js', 'bundled-catalog.js'), lines.join('\n'));
console.log('wrote js/bundled-catalog.js: ' + tables.length + ' tables, ' +
  fs.statSync(path.join(ROOT, 'js', 'bundled-catalog.js')).size + ' bytes');
