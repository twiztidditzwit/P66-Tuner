/* P66-Tuner plain-English tune summary
 * Turns analyzer suggestions and patches into language a non-tuner can
 * understand before they flash anything. This is a safety feature: nobody
 * should flash a binary they cannot describe in their own words.
 *
 *   P66.summarizeTune(suggestions, patches)
 *     -> { headline, bullets: [strings], changeCount }
 *
 * Works in browser and node. No dependencies.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  function loadWord(mapBin) {
    // "80-90" -> plain load description from the MAP range midpoint.
    var m = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(String(mapBin || '').trim());
    if (!m) return 'under load';
    var mid = (parseFloat(m[1]) + parseFloat(m[2])) / 2;
    if (mid < 40) return 'at light load';
    if (mid < 75) return 'at cruising load';
    return 'under heavy load';
  }

  function rpmWord(rpmBin) {
    var m = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(String(rpmBin || '').trim());
    if (!m) return '';
    function fmt(v) {
      return Math.round(parseFloat(v)).toLocaleString('en-US');
    }
    return 'around ' + fmt(m[1]) + '–' + fmt(m[2]) + ' RPM';
  }

  function cellWords(cell) {
    // "2000-2500 RPM / 80-90 kPa" -> "around 2,000–2,500 RPM under heavy load"
    var m = /^(\S+)\s*RPM\s*\/\s*(\S+)\s*kPa/.exec(String(cell || ''));
    if (!m) return 'in the logged driving';
    return rpmWord(m[1]) + ' ' + loadWord(m[2]);
  }

  /**
   * Build a plain-English summary of what a tune will do to the car.
   * suggestions: actionable suggestions from P66.generateSuggestions.
   * patches: patch list from the patchers (for counts).
   */
  function summarizeTune(suggestions, patches) {
    var bullets = [];
    var fuel = (suggestions || []).filter(function (s) { return s.kind === 'fuel' && s.action !== 'none'; });
    var spark = (suggestions || []).filter(function (s) { return s.kind === 'spark' && s.action !== 'none'; });
    var pe = (suggestions || []).filter(function (s) { return s.kind === 'pe' && s.action !== 'none'; });

    var addFuel = fuel.filter(function (s) { return s.deltaPct > 0; });
    var cutFuel = fuel.filter(function (s) { return s.deltaPct < 0; });

    function fuelLine(list, verb, why) {
      if (!list.length) return;
      var biggest = list.slice().sort(function (a, b) { return Math.abs(b.deltaPct) - Math.abs(a.deltaPct); })[0];
      var where = list.length === 1
        ? cellWords(biggest.cell)
        : cellWords(biggest.cell) + ' (and ' + (list.length - 1) + ' similar spot' + (list.length > 2 ? 's' : '') + ')';
      bullets.push('Fuel: your log shows the engine running ' + why + ' ' + where +
        ' — the computer was compensating. This tune ' + verb + ' about ' +
        Math.abs(biggest.deltaPct) + '% fuel there.');
    }
    fuelLine(addFuel, 'adds', 'lean');
    fuelLine(cutFuel, 'removes', 'rich');

    spark.forEach(function (s) {
      var where = (s.knockCells && s.knockCells.length)
        ? 'around ' + Math.round(s.knockCells[0].rpm / 100) * 100 + ' RPM under load'
        : 'where knock was detected';
      bullets.push('Timing: knocking (pinging) was detected ' + where +
        '. This tune pulls about ' + Math.abs(s.deltaDeg) + '° of ignition timing there to protect the engine. ' +
        'If you still hear knock after flashing, log again — do not keep driving hard on it.');
    });

    pe.forEach(function (s) {
      bullets.push('Full throttle: the air/fuel mixture was off at wide-open throttle. This tune enriches it by about ' +
        Math.abs(s.deltaPct) + '%. After flashing, log another full-throttle pull and check the O2 sensor ' +
        'reads solidly rich up top — if it still looks lean, do not keep pushing it.');
    });

    var n = (patches || []).length;
    var headline;
    if (!bullets.length) {
      headline = n
        ? 'This tune makes ' + n + ' small smoothing adjustments with no major fuel or timing changes — your log looks healthy.'
        : 'No changes: your log looks healthy. Nothing to flash.';
    } else {
      headline = 'Based on your log, this tune makes ' + bullets.length +
        ' kind' + (bullets.length > 1 ? 's' : '') + ' of change (' + n + ' table cells updated). Here is what each one does and why:';
    }

    return { headline: headline, bullets: bullets, changeCount: n };
  }

  P66.summarizeTune = summarizeTune;
})(typeof window !== 'undefined' ? window : global);
