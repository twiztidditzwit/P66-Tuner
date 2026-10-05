#!/usr/bin/env node
/*
 * xdf-parse — extract a machine-readable catalog from a TunerPro XDF file.
 *
 * Usage:
 *   node tools/xdf-parse.js <file.xdf> [--json catalog.json] [--tables-only]
 */
'use strict';

var fs = require('fs');
require('../js/xdf-map.js');
var P66 = global.P66;

function main() {
  var file = null, json = null, tablesOnly = false;
  var argv = process.argv;
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--json') json = argv[++i];
    else if (a === '--tables-only') tablesOnly = true;
    else if (!file) file = a;
    else { console.error('unknown arg: ' + a); process.exit(1); }
  }
  if (!file) {
    console.error('Usage: node tools/xdf-parse.js <file.xdf> [--json catalog.json] [--tables-only]');
    process.exit(1);
  }
  var xml = fs.readFileSync(file, 'utf8');
  var catalog = P66.parseXdfXml(xml);
  catalog.source = file.split('/').pop();
  if (tablesOnly) { delete catalog.constants; delete catalog.flags; }

  console.log('deftitle: ' + catalog.deftitle);
  console.log('tables: ' + catalog.tables.length +
    (catalog.constants ? ', constants: ' + catalog.constants.length : '') +
    (catalog.flags ? ', flags: ' + catalog.flags.length : ''));

  console.log('\nkey tables:');
  catalog.tables
    .filter(function (t) { return /Main VE|Main Spark|Idle VE|Power Enrichment|Knock|Open Loop Target/i.test(t.title); })
    .forEach(function (t) {
      console.log('  ' + (t.address || '?').padEnd(10) +
        String(t.rows + 'x' + t.cols).padEnd(8) + t.title);
    });

  if (json) {
    fs.writeFileSync(json, JSON.stringify(catalog, null, 1));
    console.log('\nwrote ' + json);
  }
}

main();
