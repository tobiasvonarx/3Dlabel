/**
 * Parsers for user-facing point-cloud files: LAS (uncompressed), PLY
 * (ascii / binary little-endian), and whitespace/comma separated XYZ text.
 * All return world-coordinate positions plus optional LiDAR classifications.
 */

export interface ParsedPointCloud {
  positions: Float64Array;
  classifications?: Uint8Array;
}

export function parsePointFile(name: string, buffer: ArrayBuffer): ParsedPointCloud {
  const extension = name.toLowerCase().split('.').pop() ?? '';
  if (extension === 'las') return parseLas(buffer);
  if (extension === 'laz') throw new Error('LAZ is compressed; convert to .las (e.g. `pdal translate` or CloudCompare) first.');
  if (extension === 'ply') return parsePly(buffer);
  if (extension === 'xyz' || extension === 'txt' || extension === 'csv') return parseXyzText(buffer);
  throw new Error(`Unsupported point file: ${name}. Use .las, .ply, .xyz, .txt, or .csv.`);
}

export function isPointFileName(name: string): boolean {
  return /\.(las|laz|ply|xyz|txt|csv)$/i.test(name);
}

// --- LAS ----------------------------------------------------------------

export function parseLas(buffer: ArrayBuffer): ParsedPointCloud {
  const view = new DataView(buffer);
  if (buffer.byteLength < 227 || readAscii(buffer, 0, 4) !== 'LASF') {
    throw new Error('Not a LAS file (missing LASF signature).');
  }
  const versionMajor = view.getUint8(24);
  const versionMinor = view.getUint8(25);
  const pointDataOffset = view.getUint32(96, true);
  const formatByte = view.getUint8(104);
  if (formatByte & 0x80) throw new Error('LAZ-compressed LAS is not supported; convert to uncompressed .las first.');
  const pointFormat = formatByte & 0x3f;
  const recordLength = view.getUint16(105, true);
  let pointCount = view.getUint32(107, true);
  if (versionMajor === 1 && versionMinor >= 4 && pointCount === 0 && buffer.byteLength >= 255) {
    pointCount = Number(view.getBigUint64(247, true));
  }
  const scaleX = view.getFloat64(131, true);
  const scaleY = view.getFloat64(139, true);
  const scaleZ = view.getFloat64(147, true);
  const offsetX = view.getFloat64(155, true);
  const offsetY = view.getFloat64(163, true);
  const offsetZ = view.getFloat64(171, true);

  const available = Math.floor((buffer.byteLength - pointDataOffset) / Math.max(recordLength, 1));
  const count = Math.min(pointCount, Math.max(available, 0));
  if (!count) throw new Error('LAS file contains no point records.');

  const classificationOffset = pointFormat >= 6 ? 16 : 15;
  const classificationMask = pointFormat >= 6 ? 0xff : 0x1f;
  const positions = new Float64Array(count * 3);
  const classifications = new Uint8Array(count);

  for (let i = 0; i < count; i += 1) {
    const base = pointDataOffset + i * recordLength;
    positions[i * 3] = view.getInt32(base, true) * scaleX + offsetX;
    positions[i * 3 + 1] = view.getInt32(base + 4, true) * scaleY + offsetY;
    positions[i * 3 + 2] = view.getInt32(base + 8, true) * scaleZ + offsetZ;
    classifications[i] = view.getUint8(base + classificationOffset) & classificationMask;
  }
  return { positions, classifications };
}

// --- PLY ----------------------------------------------------------------

interface PlyProperty {
  name: string;
  type: string;
}

const PLY_TYPE_SIZES: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8
};

function parsePly(buffer: ArrayBuffer): ParsedPointCloud {
  const headerProbe = new TextDecoder().decode(buffer.slice(0, Math.min(buffer.byteLength, 64 * 1024)));
  const headerEnd = headerProbe.indexOf('end_header');
  if (!headerProbe.startsWith('ply') || headerEnd < 0) throw new Error('Not a PLY file.');
  const headerText = headerProbe.slice(0, headerEnd);
  const bodyOffset = headerProbe.indexOf('\n', headerEnd) + 1;

  let format = '';
  let vertexCount = 0;
  const properties: PlyProperty[] = [];
  let inVertexElement = false;
  for (const line of headerText.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'format') format = parts[1];
    else if (parts[0] === 'element') {
      inVertexElement = parts[1] === 'vertex';
      if (inVertexElement) vertexCount = Number(parts[2]);
    } else if (parts[0] === 'property' && inVertexElement) {
      if (parts[1] === 'list') throw new Error('PLY vertex list properties are not supported.');
      properties.push({ type: parts[1], name: parts[2] });
    }
  }
  if (!vertexCount) throw new Error('PLY file has no vertices.');
  const fieldIndex = (name: string) => properties.findIndex((property) => property.name === name);
  const xIndex = fieldIndex('x');
  const yIndex = fieldIndex('y');
  const zIndex = fieldIndex('z');
  if (xIndex < 0 || yIndex < 0 || zIndex < 0) throw new Error('PLY file is missing x/y/z vertex properties.');
  const classIndex = ['classification', 'class', 'scalar_classification'].map(fieldIndex).find((index) => index >= 0) ?? -1;

  const positions = new Float64Array(vertexCount * 3);
  const classifications = classIndex >= 0 ? new Uint8Array(vertexCount) : undefined;

  if (format === 'ascii') {
    const text = new TextDecoder().decode(buffer.slice(bodyOffset));
    const lines = text.split(/\r?\n/);
    let vertex = 0;
    for (const line of lines) {
      if (vertex >= vertexCount) break;
      const parts = line.trim().split(/\s+/);
      if (parts.length < properties.length) continue;
      positions[vertex * 3] = Number(parts[xIndex]);
      positions[vertex * 3 + 1] = Number(parts[yIndex]);
      positions[vertex * 3 + 2] = Number(parts[zIndex]);
      if (classifications) classifications[vertex] = Number(parts[classIndex]) & 0xff;
      vertex += 1;
    }
    if (vertex < vertexCount) throw new Error('PLY file ended before all vertices were read.');
    return { positions, classifications };
  }

  if (format !== 'binary_little_endian') throw new Error(`Unsupported PLY format: ${format}.`);
  const view = new DataView(buffer);
  const stride = properties.reduce((sum, property) => sum + (PLY_TYPE_SIZES[property.type] ?? 0), 0);
  const offsets = properties.map((property, index) =>
    properties.slice(0, index).reduce((sum, item) => sum + (PLY_TYPE_SIZES[item.type] ?? 0), 0)
  );
  const readValue = (recordBase: number, index: number): number => {
    const property = properties[index];
    const offset = recordBase + offsets[index];
    switch (property.type) {
      case 'char': case 'int8': return view.getInt8(offset);
      case 'uchar': case 'uint8': return view.getUint8(offset);
      case 'short': case 'int16': return view.getInt16(offset, true);
      case 'ushort': case 'uint16': return view.getUint16(offset, true);
      case 'int': case 'int32': return view.getInt32(offset, true);
      case 'uint': case 'uint32': return view.getUint32(offset, true);
      case 'float': case 'float32': return view.getFloat32(offset, true);
      default: return view.getFloat64(offset, true);
    }
  };
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const base = bodyOffset + vertex * stride;
    positions[vertex * 3] = readValue(base, xIndex);
    positions[vertex * 3 + 1] = readValue(base, yIndex);
    positions[vertex * 3 + 2] = readValue(base, zIndex);
    if (classifications) classifications[vertex] = readValue(base, classIndex) & 0xff;
  }
  return { positions, classifications };
}

// --- XYZ / CSV ----------------------------------------------------------

function parseXyzText(buffer: ArrayBuffer): ParsedPointCloud {
  const text = new TextDecoder().decode(buffer);
  const lines = text.split(/\r?\n/);
  const xs: number[] = [];
  const classes: number[] = [];
  let sawClass = false;
  for (const line of lines) {
    const parts = line.trim().split(/[,;\s]+/);
    if (parts.length < 3) continue;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    xs.push(x, y, z);
    const classValue = parts.length >= 4 ? Number(parts[3]) : Number.NaN;
    if (Number.isInteger(classValue) && classValue >= 0 && classValue <= 255) {
      classes.push(classValue);
      sawClass = true;
    } else {
      classes.push(0);
    }
  }
  if (!xs.length) throw new Error('No numeric x y z rows found in text point file.');
  return {
    positions: Float64Array.from(xs),
    classifications: sawClass ? Uint8Array.from(classes) : undefined
  };
}

function readAscii(buffer: ArrayBuffer, offset: number, length: number): string {
  return new TextDecoder().decode(new Uint8Array(buffer, offset, length));
}
