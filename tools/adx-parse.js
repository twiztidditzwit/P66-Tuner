#!/usr/bin/env node
/* P66 ADX parser — TunerPro ADX (ALDL acquisition definition) -> catalog JSON.
 *
 * Usage: node tools/adx-parse.js defs/adx/p66-v6.adx [out.json]
 *
 * Emits { header, commands[], datastream[], computed[] }:
 *  - commands: ALDL request frames (bytestring) the ADX can send, e.g.
 *    Mode 1 Message 0 (main datastream), Mode 8/9/10, VIN, code reads.
 *  - datastream: raw packet channels — title, units, packet offset,
 *    size in bits, conversion equation, parent command.
 *  - computed: TunerPro-calculated channels (multi-variable equations,
 *    not raw packet bytes).
 */
'use strict';
const fs = require('fs');

const src = process.argv[2] || 'defs/adx/p66-v6.adx';
const out = process.argv[3] || src.replace(/\.adx$/i, '.catalog.json');
const adx = fs.readFileSync(src, 'utf8');

function grab(body, re) {
  const m = re.exec(body);
  return m ? m[1] : '';
}

// --- header ---
const headerBlock = grab(adx, /<ADXHEADER>([\s\S]*?)<\/ADXHEADER>/);
const header = {
  guid: grab(headerBlock, /<guid>([^<]*)<\/guid>/),
  author: grab(headerBlock, /<author>([^<]*)<\/author>/),
  desc: grab(headerBlock, /<desc>([^<]*)<\/desc>/),
  baud: grab(headerBlock, /<baud>([^<]*)<\/baud>/),
  objectcount: grab(headerBlock, /<objectcount>([^<]*)<\/objectcount>/),
};

// --- send commands ---
const commands = [];
const cre = /<ADXCSENDCOMMAND id="([^"]+)" idhash="(0x[0-9A-Fa-f]+)" title="([^"]+)"[^>]*>([\s\S]*?)<\/ADXCSENDCOMMAND>/g;
let cm;
while ((cm = cre.exec(adx)) !== null) {
  commands.push({
    id: cm[1],
    idhash: cm[2],
    title: cm[3],
    size: grab(cm[4], /<bytestring size="([^"]+)"/),
    bytestring: grab(cm[4], /<bytestring[^>]*>([0-9A-Fa-f]+)<\/bytestring>/),
  });
}

// --- values ---
const datastream = [];
const computed = [];
const vre = /<ADXVALUE id="([^"]+)" idhash="(0x[0-9A-Fa-f]+)" title="([^"]*)"[^>]*>([\s\S]*?)<\/ADXVALUE>/g;
let vm;
while ((vm = vre.exec(adx)) !== null) {
  const body = vm[4];
  const parent = grab(body, /<parentcmdidhash>([^<]*)<\/parentcmdidhash>/);
  const v = {
    id: vm[1],
    idhash: vm[2],
    title: vm[3] || null, // some lookup-table values have empty titles
    parentcmdidhash: parent || null,
    units: grab(body, /<units>([^<]*)<\/units>/),
    packetoffset: grab(body, /<packetoffset>([^<]*)<\/packetoffset>/),
    sizeinbits: grab(body, /<sizeinbits>([^<]*)<\/sizeinbits>/) || null,
    equation: grab(body, /<MATH equation="([^"]*)"/),
    outputtype: grab(body, /<outputtype>([^<]*)<\/outputtype>/),
  };
  // Raw datastream channel: has a parent command AND a nonzero packet offset.
  // (TunerPro-computed channels use off=0x00 with multi-variable equations.)
  if (parent && v.packetoffset && v.packetoffset !== '0x00') datastream.push(v);
  else computed.push(v);
}

const catalog = {
  source: src,
  generated: new Date().toISOString(),
  header,
  commands,
  datastream,
  computed,
};

fs.writeFileSync(out, JSON.stringify(catalog, null, 2) + '\n');
console.log(`ADX: ${src}`);
console.log(`  header: ${header.author || '?'} @ ${header.baud || '?'} baud, ${header.objectcount || '?'} objects`);
console.log(`  commands: ${commands.length}`);
console.log(`  datastream channels: ${datastream.length}`);
console.log(`  computed channels: ${computed.length}`);
console.log(`  wrote ${out}`);
