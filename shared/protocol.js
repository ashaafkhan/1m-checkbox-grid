export const CHECKBOX_COUNT = 1_000_000;
export const GRID_COLUMNS = 1000;
export const GRID_ROWS = CHECKBOX_COUNT / GRID_COLUMNS;
export const BITMASK_SIZE = Math.ceil(CHECKBOX_COUNT / 8);

export const MESSAGE_TYPE = {
  SNAPSHOT: 1,
  PATCH: 2,
  STATS: 3,
  TOGGLE: 10,
  RESET: 11,
};

export function getBit(bitmask, index) {
  const byteIndex = index >> 3;
  const bitIndex = index & 7;
  return (bitmask[byteIndex] >> bitIndex) & 1;
}

export function setBit(bitmask, index, value) {
  const byteIndex = index >> 3;
  const bitIndex = index & 7;

  if (value) {
    bitmask[byteIndex] |= 1 << bitIndex;
    return;
  }

  bitmask[byteIndex] &= ~(1 << bitIndex);
}

export function encodeToggle(index) {
  const packet = new ArrayBuffer(5);
  const view = new DataView(packet);
  view.setUint8(0, MESSAGE_TYPE.TOGGLE);
  view.setUint32(1, index, true);
  return packet;
}

export function decodeToggle(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 5) {
    return null;
  }

  const view = new DataView(buffer);
  if (view.getUint8(0) !== MESSAGE_TYPE.TOGGLE) {
    return null;
  }

  return view.getUint32(1, true);
}

export function encodeReset() {
  const packet = new ArrayBuffer(1);
  const view = new DataView(packet);
  view.setUint8(0, MESSAGE_TYPE.RESET);
  return packet;
}

export function decodeReset(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 1) {
    return false;
  }

  const view = new DataView(buffer);
  return view.getUint8(0) === MESSAGE_TYPE.RESET;
}

export function encodeSnapshot(bitmask) {
  const packet = new Uint8Array(1 + bitmask.byteLength);
  packet[0] = MESSAGE_TYPE.SNAPSHOT;
  packet.set(bitmask, 1);
  return packet.buffer;
}

export function decodeSnapshot(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 1 + BITMASK_SIZE) {
    return null;
  }

  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== MESSAGE_TYPE.SNAPSHOT) {
    return null;
  }

  return bytes.subarray(1, 1 + BITMASK_SIZE);
}

export function encodePatch(index, value) {
  const packet = new ArrayBuffer(6);
  const view = new DataView(packet);
  view.setUint8(0, MESSAGE_TYPE.PATCH);
  view.setUint32(1, index, true);
  view.setUint8(5, value ? 1 : 0);
  return packet;
}

export function decodePatch(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 6) {
    return null;
  }

  const view = new DataView(buffer);
  if (view.getUint8(0) !== MESSAGE_TYPE.PATCH) {
    return null;
  }

  return {
    index: view.getUint32(1, true),
    value: view.getUint8(5),
  };
}

export function encodeStats(checked, clients) {
  const packet = new ArrayBuffer(11);
  const view = new DataView(packet);
  view.setUint8(0, MESSAGE_TYPE.STATS);
  view.setUint32(1, checked, true);
  view.setUint32(5, CHECKBOX_COUNT, true);
  view.setUint16(9, clients, true);
  return packet;
}

export function decodeStats(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 11) {
    return null;
  }

  const view = new DataView(buffer);
  if (view.getUint8(0) !== MESSAGE_TYPE.STATS) {
    return null;
  }

  return {
    checked: view.getUint32(1, true),
    total: view.getUint32(5, true),
    clients: view.getUint16(9, true),
  };
}
