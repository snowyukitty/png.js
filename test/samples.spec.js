import { deflateSync } from 'zlib';
import PNGNode from '../lib/png-js.cjs';
import PNGBrowser from '../lib/png-js.browser.js';

function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 'ascii');
  data.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

function makePng(colorType, bits, interlaced, suggestedPalette = false) {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const size = 8;
  const raw = Buffer.alloc(size * size * channels * (bits / 8));
  const rgba = [];
  for (let pixel = 0; pixel < size * size; pixel++) {
    const values = Array.from(
      { length: channels },
      (_, channel) => (pixel * 37 + channel * 83) & 255
    );
    values.forEach((value, channel) => {
      const offset = (pixel * channels + channel) * (bits / 8);
      raw[offset] = value;
      if (bits === 16) raw[offset + 1] = 255 - value;
    });
    // RGBA8 uses the PNG-permitted high-byte truncation, including alpha.
    rgba.push(
      ...(colorType === 0 || colorType === 4
        ? [values[0], values[0], values[0]]
        : values.slice(0, 3)),
      colorType === 4 || colorType === 6 ? values[channels - 1] : 255
    );
  }
  const passes = interlaced
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2]
      ]
    : [[0, 0, 1, 1]];
  const rows = [];
  const pixelBytes = channels * (bits / 8);
  let rowNumber = 0;
  for (const [x0, y0, dx, dy] of passes) {
    let previous = [];
    for (let y = y0; y < size; y += dy) {
      const row = [];
      for (let x = x0; x < size; x += dx) {
        const offset = (y * size + x) * pixelBytes;
        row.push(...raw.subarray(offset, offset + pixelBytes));
      }
      if (!row.length) continue;
      const filter = rowNumber++ % 5;
      const filtered = row.map((value, i) => {
        const left = i < pixelBytes ? 0 : row[i - pixelBytes];
        const up = previous[i] || 0;
        const upperLeft = i < pixelBytes ? 0 : previous[i - pixelBytes] || 0;
        const p = left + up - upperLeft;
        const distances = [left, up, upperLeft].map(neighbor =>
          Math.abs(p - neighbor)
        );
        const paeth = [left, up, upperLeft][
          distances.indexOf(Math.min(...distances))
        ];
        const predictor = [0, left, up, Math.floor((left + up) / 2), paeth][
          filter
        ];
        return (value - predictor) & 255;
      });
      rows.push(Buffer.from([filter, ...filtered]));
      previous = row;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = bits;
  header[9] = colorType;
  header[12] = Number(interlaced);
  return {
    buffer: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      ...(suggestedPalette
        ? [chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255]))]
        : []),
      chunk('IDAT', deflateSync(Buffer.concat(rows))),
      chunk('IEND', Buffer.alloc(0))
    ]),
    raw,
    rgba
  };
}

describe.each([
  ['node', PNGNode],
  ['browser module', PNGBrowser],
  ['standalone browser', PNG]
])('%s sample conversion', (_, Ctor) => {
  test('indexed colors retain their 8-bit palette alpha', () => {
    const header = Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 3, 0, 0, 0]);
    const image = new Ctor(
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255])),
        chunk('tRNS', Buffer.from([128, 255])),
        chunk('IDAT', deflateSync(Buffer.from([0, 0, 1]))),
        chunk('IEND', Buffer.alloc(0))
      ])
    );
    const pixels =
      Ctor === PNG ? image.decodePixels() : image.decodePixelsSync();
    const result = new Uint8Array(8);
    image.copyToImageData(result, pixels);
    expect(Array.from(result)).toEqual([255, 0, 0, 128, 0, 0, 255, 255]);
  });
  test.each(
    [0, 2, 4, 6].flatMap(colorType =>
      [false, true].flatMap(interlaced =>
        [8, 16].flatMap(bits =>
          (colorType === 2 || colorType === 6 ? [false, true] : [false]).map(
            palette => [colorType, interlaced, bits, palette]
          )
        )
      )
    )
  )(
    'color type %i, interlaced %s, %i-bit, suggested palette %s',
    async (colorType, interlaced, bits, palette) => {
      const { buffer, raw, rgba } = makePng(
        colorType,
        bits,
        interlaced,
        palette
      );
      const image = new Ctor(buffer);
      const pixels =
        Ctor === PNG ? image.decodePixels() : image.decodePixelsSync();
      expect(Array.from(pixels)).toEqual(Array.from(raw));
      const result = new Uint8Array(8 * 8 * 4);
      image.copyToImageData({ data: result }, pixels);
      expect(Array.from(result)).toEqual(rgba);
      expect(Array.from(pixels)).toEqual(Array.from(raw));
      if (Ctor === PNGNode) {
        expect(
          Array.from(await new Promise(resolve => image.decode(resolve)))
        ).toEqual(rgba);
      } else if (Ctor === PNG) {
        expect(Array.from(image.decode())).toEqual(rgba);
      }
    }
  );
});
