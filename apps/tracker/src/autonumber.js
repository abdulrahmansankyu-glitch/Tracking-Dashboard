/**
 * Reference numbers the app allocates itself.
 *
 * Action Notices are numbered `PA-2607-09`: a fixed prefix, the two-digit year,
 * the two-digit month, and a serial that restarts at 01 each month. Somebody
 * had been reading the last row of the sheet and adding one, which is fine
 * until two people do it in the same afternoon.
 *
 * Deliberately free of storage and HTTP so the rule can be tested on its own,
 * and so the server and the form are working from the same function rather than
 * two implementations that agree until one of them is edited.
 */

/** The `YYMM` part of a date — `2026-08-13` becomes `2608`. */
export function periodOf(date = new Date()) {
  const yy = String(date.getFullYear() % 100).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${yy}${mm}`;
}

/**
 * Read a reference back into its parts, or null if it is not one of ours.
 *
 * The serial is matched with `\d+` rather than exactly two digits: the
 * nineteen-a-month they raise today will not always be nineteen, and a
 * hundredth notice must not read as unparseable and silently restart the count.
 */
export function parseRef(value, prefix) {
  const match = String(value ?? '')
    .trim()
    .toUpperCase()
    .match(new RegExp(`^${prefix}-(\\d{4})-(\\d+)$`));
  if (!match) return null;
  return { prefix, period: match[1], serial: Number.parseInt(match[2], 10) };
}

export function formatRef(prefix, period, serial) {
  // Padded to two digits, which is what the existing sheet uses; a serial past
  // 99 simply gets longer rather than being truncated to fit.
  return `${prefix}-${period}-${String(serial).padStart(2, '0')}`;
}

/**
 * The next reference for this period, given everything already issued.
 *
 * Takes the highest serial in the current period and adds one — not the count
 * of records. Counting would reissue a number as soon as anything was deleted,
 * and these numbers appear on paperwork that has already left the building.
 *
 * References from other periods are ignored, so August starts at 01 however
 * many July notices exist.
 */
export function nextRef(existing, { prefix, period = periodOf() } = {}) {
  let highest = 0;
  for (const value of existing) {
    const parsed = parseRef(value, prefix);
    if (parsed && parsed.period === period && parsed.serial > highest) highest = parsed.serial;
  }
  return formatRef(prefix, period, highest + 1);
}
