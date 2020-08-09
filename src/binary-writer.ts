import fs from 'fs';
import { seekSync } from 'fs-ext'
import { writeByte, openNullDevice, canWrite, flushAsync } from './utils/file'
import { isSurrogate } from './utils/string';
import { raise } from './utils/error';
import { CSCode } from './constants/error';
import { INT_MIN, INT_MAX } from './constants/number';
import { IEncoding, Encoding } from './encoding';
import { CStr, RawStr } from './constants/mode';

type char = string;

const MIN_LONG = BigInt('-9223372036854775808');
const LONG_WRAP = BigInt('18446744073709551616');
const MAX_LONG = BigInt("9223372036854775807");
const INT_WRAP = 4294967296;
const BIG_SEVEN = BigInt(7);
const BIG_7Fh = BigInt(0x7F);
const BIG_0 = BigInt(0);
const MASK_8_BIT = 0xFF;
/**
 * Writes primitive types in binary to a file and supports writing strings in a specific encoding.
 */
export class BinaryWriter {
  static get null(): BinaryWriter {
    return new BinaryWriter(openNullDevice());
  }

  protected _fd: number;
  private readonly _encoding: IEncoding;
  private readonly _leaveOpen: boolean = false;
  private _disposed: boolean = false;

  /**
   * Initializes a new instance of the BinaryWriter class based on the specified file and character encoding, and optionally leaves the file open.
   * @param output The output file.
   * @param encoding The character encoding to use.
   * @param leaveOpen `true` to leave the file open after the BinaryWriter object is disposed; otherwise, `false`.
   */
  constructor(output: number, encoding: BufferEncoding | string | IEncoding = 'utf8', leaveOpen = false) {
    if (!Number.isSafeInteger(output)) throw TypeError('"output" must be a safe integer.');
    if (typeof encoding != 'string') throw TypeError('"encoding" must be a string.');
    if (typeof leaveOpen != 'boolean') throw TypeError('"leaveOpen" must be a boolean.');
    if (!canWrite(output)) raise(ReferenceError('Output file is not writable.'), CSCode.FileNotWritable);

    this._fd = output;
    if (typeof encoding == 'string')
      this._encoding = new Encoding(encoding);
    else if (typeof encoding == 'object')
      this._encoding = encoding as IEncoding;
    this._leaveOpen = leaveOpen;
  }

  /**
   * Closes this writer and releases any system resources associated with the writer. Following a call to Close, any operations on the writer may raise exceptions.
   */
  close(): void {
    if (!this._disposed) {
      if (this._leaveOpen)
        fs.fdatasyncSync(this._fd);
      else
        fs.closeSync(this._fd);
      this._disposed = true;
    }
  }

  private throwIfDisposed(): void {
    if (this._disposed) {
      raise(ReferenceError('This BinaryWriter instance is closed.'), CSCode.FileIsClosed);
    }
  }

  /**
   * The async version of the close method.
   */
  async closeAsync(): Promise<void> {
    if (!this._disposed) {
      if (this.constructor == BinaryWriter) {
        if (this._leaveOpen)
          await flushAsync(this._fd);
        else
          fs.closeSync(this._fd);
      } else {
        // Since this is a derived BinaryWriter, delegate to whatever logic the derived implementation already has in close.
        this.close();
      }
      this._disposed = true;
    }
  }

  /**
   * Returns the file associated with the writer. It flushes all pending writes before returning. All subclasses should override flush to ensure that all buffered data is sent to the file.
   */
  get baseFd(): number {
    this.flush();
    return this._fd;
  }

  /**
   * Clears all buffers for this writer and causes any buffered data to be written to the underlying device.
   */
  flush(): void {
    this.throwIfDisposed();
    fs.fdatasyncSync(this._fd);
  }

  /**
   * Sets the position within the current file.
   * @param offset A byte offset relative to `origin`.
   * @param origin A field indicating the reference point from which the new position is to be obtained. Expected SEEK_SET, SEEK_CUR and SEEK_END value exposed from C header file.
   * @returns The position with the current file.
   */
  seek(offset: number, origin: number): number {
    this.throwIfDisposed();
    return seekSync(this._fd, offset, origin);
  }

  /**
   * Writes a one-byte Boolean value to the current file, with `0` representing `false` and `1` representing `true`.
   * @param value The Boolean value to write (`0` or `1`).
   */
  writeBoolean(value: boolean): void {
    if (typeof value != 'boolean') throw TypeError('"value" must be a boolean.');
    this.throwIfDisposed();
    let buffer = Buffer.allocUnsafe(1).fill(value ? 1 : 0);
    fs.writeSync(this._fd, buffer, 0, 1);
  }

  /**
   * Writes an unsigned byte to the current file and advances the file position by one byte.
   * @param value The unsigned byte to write.
   */
  writeByte(value: number): void {
    if (!Number.isSafeInteger(value)) throw TypeError('"value" must be a safe integer.');
    this.throwIfDisposed();
    writeByte(this._fd, value);
  }

  /**
   * Writes a signed byte to the current file and advances the file position by one byte.
   * @param value 
   */
  writeSByte(value: number): void {
    if (!Number.isSafeInteger(value)) throw TypeError('"value" must be a safe integer.');
    if (value < -128 || value > 127) throw RangeError('"value" must be in range [-128:127].');
    this.throwIfDisposed();
    writeByte(this._fd, value < 0 ? value + 256 : value);
  }

  /**
   * Writes a byte array to the underlying file.
   * @param buffer A byte array containing the data to write.
   */
  writeBuffer(buffer: Buffer): void {
    if (!Buffer.isBuffer(buffer)) throw TypeError('"buffer" must be a Buffer.');
    this.throwIfDisposed();
    fs.writeSync(this._fd, buffer, 0, buffer.length);
  }

  /**
   * Writes a region of a byte array to the current file.
   * @param buffer A byte array containing the data to write.
   * @param index The index of the first byte to read from `buffer` and to write to the file.
   * @param count The number of bytes to read from `buffer` and to write to the file.
   */
  writeBufferEx(buffer: Buffer, index: number, count: number): void {
    if (!Buffer.isBuffer(buffer)) throw TypeError('"buffer" must be a Buffer.');
    if (!Number.isSafeInteger(index)) throw TypeError('"index" must be a safe integer.');
    if (!Number.isSafeInteger(count)) throw TypeError('"count" must be a safe integer.');
    this.throwIfDisposed();
    fs.writeSync(this._fd, buffer, index, count);
  }

  /**
   * Writes a Unicode character to the current file and advances the current position of the file in accordance with the Encoding used and the specific characters being written to the file.
   * @param ch The non-surrogate, Unicode character to write.
   */
  writeChar(ch: char): void {
    if (typeof ch != 'string' || ch.length > 1) throw TypeError('"ch" must be a single character string.');
    if (isSurrogate(ch))
      throw RangeError('Surrogates are not allowed as single character string.');
    this.throwIfDisposed();
    const bytes = this._encoding.encode(ch);
    fs.writeSync(this._fd, bytes, 0, bytes.length);
  }

  /**
   * Writes a character array to the current file and advances the current position of the file in accordance with the Encoding used and the specific characters being written to the file.
   * @param chars A character array containing the data to write.
   */
  writeChars(chars: char[]): void {
    if (!Array.isArray(chars)) throw TypeError('"chars" must be a single character array.');
    const _chars = chars.join(''); // TODO: I don't know any better way
    if (chars.length != _chars.length)
      throw RangeError('Please use an actual single character array.');
    this.throwIfDisposed();
    const bytes = this._encoding.encode(_chars);
    fs.writeSync(this._fd, bytes, 0, bytes.length);
  }

  /**
   * Writes a section of a character array to the current file, and advances the current position of the file in accordance with the Encoding used and perhaps the specific characters being written to the file.
   * @param chars A character array containing the data to write.
   * @param index The index of the first character to read from `chars` and to write to the stream.
   * @param count The number of characters to read from `chars` and to write to the stream.
   */
  writeCharsEx(chars: char[], index: number, count: number): void {
    if (!Array.isArray(chars)) throw TypeError('"chars" must be a single character array.');
    if (!Number.isSafeInteger(index)) throw TypeError('"index" must be a safe integer.');
    if (!Number.isSafeInteger(count)) throw TypeError('"count" must be a safe integer.');
    this.throwIfDisposed();
    let _chars = '';
    let end = index + count;
    if (end > chars.length)
      end = chars.length;
    for (let i = index; i < end; i++) {
      if (chars[i].length > 1)
        throw RangeError('Please use an actual single character array.');
      _chars += chars[i];  // TODO: I don't know any better way
    }
    const bytes = this._encoding.encode(_chars);
    fs.writeSync(this._fd, bytes, 0, bytes.length);
  }

  /**
   * Writes an eight-byte floating-point value to the current file and advances the file position by eight bytes.
   * @param value The eight-byte floating-point value to write.
   */
  writeDouble(value: number): void {
    if (typeof value != 'number') throw TypeError('"value" must be a number.');
    this.throwIfDisposed();
    let buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleLE(value);
    fs.writeSync(this._fd, buffer, 0, buffer.length);
  }

  /** Not supported */
  writeDecimal(value: number): void {
    throw Error('Decimal is not supported.');
  }

  /**
   * Writes a two-byte signed integer to the current file and advances the file position by two bytes.
   * @param value The two-byte signed integer to write.
   */
  writeInt16(value: number): void {
    if (!Number.isSafeInteger(value)) throw TypeError('"value" must be a safe integer.');
    this.throwIfDisposed();
    let buffer = Buffer.allocUnsafe(2);
    buffer.writeInt16LE(value);
    fs.writeSync(this._fd, buffer, 0, buffer.length);
  }

  /**
   * Writes a two-byte unsigned integer to the current file and advances the file position by two bytes.
   * @param value The two-byte unsigned integer to write.
   */
  writeUInt16(value: number): void {
    if (!Number.isSafeInteger(value)) throw TypeError('"value" must be a safe integer.');
    this.throwIfDisposed();
    let buffer = Buffer.allocUnsafe(2);
    buffer.writeUInt16LE(value);
    fs.writeSync(this._fd, buffer, 0, buffer.length);
  }

  /**
   * Writes a four-byte signed integer to the current file and advances the file position by four bytes.
   * @param value The four-byte signed integer to write.
   */
  writeInt32(value: number): void {
    if (!Number.isSafeInteger(value)) throw TypeError('"value" must be a safe integer.');
    this.throwIfDisposed();
    let buffer = Buffer.allocUnsafe(4);
    buffer.writeInt32LE(value);
    fs.writeSync(this._fd, buffer, 0, buffer.length);
  }

  /**
   * Writes a four-byte unsigned integer to the current file and advances the file position by four bytes.
   * @param value The four-byte unsigned integer to write.
   */
  writeUInt32(value: number): void {
    if (!Number.isSafeInteger(value)) throw TypeError('"value" must be a safe integer.');
    this.throwIfDisposed();
    let buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32LE(value);
    fs.writeSync(this._fd, buffer, 0, buffer.length);
  }

  /**
   * Writes an eight-byte signed integer to the current file and advances the file position by eight bytes.
   * @param value The eight-byte signed integer to write.
   */
  writeInt64(value: bigint): void {
    if (typeof value != 'bigint') throw TypeError('"value" must be a bigint.');
    this.throwIfDisposed();
    let buffer = Buffer.allocUnsafe(8);
    buffer.writeBigInt64LE(value);
    fs.writeSync(this._fd, buffer, 0, buffer.length);
  }

  /**
   * Writes an eight-byte unsigned integer to the current file and advances the file position by eight bytes.
   * @param value The eight-byte unsigned integer to write.
   */
  writeUInt64(value: bigint): void {
    if (typeof value != 'bigint') throw TypeError('"value" must be a bigint.');
    this.throwIfDisposed();
    let buffer = Buffer.allocUnsafe(8);
    buffer.writeBigUInt64LE(value);
    fs.writeSync(this._fd, buffer, 0, buffer.length);
  }

  /**
   * Writes a four-byte floating-point value to the current file and advances the file position by four bytes.
   * @param value The four-byte floating-point value to write.
   */
  writeSingle(value: number): void {
    if (typeof value != 'number') throw TypeError('"value" must be a number.');
    this.throwIfDisposed();
    let buffer = Buffer.allocUnsafe(4);
    buffer.writeFloatLE(value);
    fs.writeSync(this._fd, buffer, 0, buffer.length);
  }

  /**
   * Writes a length-prefixed string to this file in the current encoding of the BinaryWriter, and advances the current position of the file in accordance with the encoding used and the specific characters being written to the file.
   * @param value The value to write.
   */
  writeString(value: string, mode?: number): void {
    if (typeof value != 'string') throw TypeError('"value" must be a string.');
    this.throwIfDisposed();

    if (mode != CStr && mode != RawStr) {
      let totalBytes = this._encoding.byteLength(value);
      this.write7BitEncodedInt(totalBytes);
    }
    const bytes = this._encoding.encode(value);
    fs.writeSync(this._fd, bytes, 0, bytes.length);
    if (mode == CStr) {
      const nullBytes = this._encoding.encode('\0');
      fs.writeSync(this._fd, nullBytes, 0, nullBytes.length);
    }
  }

  /**
   * Writes a 32-bit integer in a compressed format.
   * @param value The 32-bit integer to be written.
   */
  write7BitEncodedInt(value: number): void {
    if (!Number.isSafeInteger(value)) throw TypeError('"value" must be a safe integer.');
    if (value < INT_MIN || value > INT_MAX) throw RangeError(`"value" must be in range [${INT_MIN}:${INT_MAX}}].`)
    this.throwIfDisposed();

    let uValue = value < 0 ? value + INT_WRAP : value;

    // Write out an int 7 bits at a time. The high bit of the byte,
    // when on, tells reader to continue reading more bytes.

    while (uValue > 0x7F) {
      this.writeByte((uValue | 0x80) & MASK_8_BIT);
      uValue >>>= 7;
    }

    this.writeByte(uValue);
  }

  /**
   * Writes a 64-bit integer in a compressed format.
   * @param value The 64-bit integer to be written.
   */
  write7BitEncodedInt64(value: bigint): void {
    if (typeof value != 'bigint') throw TypeError('"value" must be a bigint.');
    if (value < MIN_LONG || value > MAX_LONG) throw RangeError(`"value" must be in range [${MIN_LONG}:${MAX_LONG}].`);
    this.throwIfDisposed();

    let uValue = value < BIG_0 ? value + LONG_WRAP : value;

    // Write out an int 7 bits at a time. The high bit of the byte,
    // when on, tells reader to continue reading more bytes.

    while (uValue > BIG_7Fh) {
      this.writeByte(Number(BigInt.asUintN(8, uValue)) | 0x80)
      uValue >>= BIG_SEVEN;
    }

    this.writeByte(Number(uValue));
  }
}