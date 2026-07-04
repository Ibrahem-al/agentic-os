/**
 * Builds a tiny, valid ONNX model in memory (hand-encoded protobuf — no
 * Python toolchain needed) that stands in for the bge-reranker cross-encoder
 * in unit tests:
 *
 *   inputs : input_ids [batch, seq] int64, attention_mask [batch, seq] int64
 *   graph  : logits = ReduceMean(Cast<float>(input_ids), axes=[1], keepdims=1)
 *   output : logits [batch, 1] float32
 *
 * With the stub char-code tokenizer, a doc's score is the mean of its token
 * ids — so docs made of later letters deterministically outrank docs made of
 * earlier ones (use equal-length docs so padding cannot skew the mean).
 * onnxruntime-node loads and runs this for real, which exercises the exact
 * session/tensor plumbing the production model uses.
 */

// ── minimal protobuf wire-format writers ─────────────────────────────────────

function varint(value: number | bigint): number[] {
  let v = BigInt(value)
  if (v < 0n) throw new Error('varint: negative values not needed here')
  const out: number[] = []
  do {
    let byte = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) byte |= 0x80
    out.push(byte)
  } while (v > 0n)
  return out
}

function tag(fieldNumber: number, wireType: number): number[] {
  return varint((fieldNumber << 3) | wireType)
}

/** wire type 0 — varint scalar field. */
function varintField(fieldNumber: number, value: number | bigint): number[] {
  return [...tag(fieldNumber, 0), ...varint(value)]
}

/** wire type 2 — length-delimited field (submessage / bytes). */
function lenField(fieldNumber: number, bytes: number[]): number[] {
  return [...tag(fieldNumber, 2), ...varint(bytes.length), ...bytes]
}

function strField(fieldNumber: number, text: string): number[] {
  return lenField(fieldNumber, [...Buffer.from(text, 'utf8')])
}

// ── ONNX message builders (field numbers per onnx.proto) ─────────────────────

const ELEM_FLOAT = 1
const ELEM_INT64 = 7
const ATTR_INT = 2
const ATTR_INTS = 7

/** TypeProto{ tensor_type{ elem_type, shape{ dim* } } } */
function tensorValueInfo(name: string, elemType: number, dims: (string | number)[]): number[] {
  const dimMsgs = dims.map((d) => (typeof d === 'number' ? varintField(1, d) : strField(2, d)))
  const shape = dimMsgs.flatMap((dim) => lenField(1, dim))
  const tensorType = [...varintField(1, elemType), ...lenField(2, shape)]
  const typeProto = lenField(1, tensorType)
  // ValueInfoProto: name=1, type=2
  return [...strField(1, name), ...lenField(2, typeProto)]
}

/** AttributeProto: name=1, i=3, ints=8, type=20 */
function intAttribute(name: string, value: number): number[] {
  return [...strField(1, name), ...varintField(3, value), ...varintField(20, ATTR_INT)]
}

function intsAttribute(name: string, values: number[]): number[] {
  return [...strField(1, name), ...values.flatMap((v) => varintField(8, v)), ...varintField(20, ATTR_INTS)]
}

/** NodeProto: input=1, output=2, name=3, op_type=4, attribute=5 */
function node(opType: string, name: string, inputs: string[], outputs: string[], attributes: number[][]): number[] {
  return [
    ...inputs.flatMap((i) => strField(1, i)),
    ...outputs.flatMap((o) => strField(2, o)),
    ...strField(3, name),
    ...strField(4, opType),
    ...attributes.flatMap((a) => lenField(5, a))
  ]
}

/** The fixture ModelProto bytes. */
export function buildFixtureOnnxModel(): Buffer {
  const castNode = node('Cast', 'cast_ids', ['input_ids'], ['ids_float'], [intAttribute('to', ELEM_FLOAT)])
  const meanNode = node(
    'ReduceMean',
    'mean_ids',
    ['ids_float'],
    ['logits'],
    [intsAttribute('axes', [1]), intAttribute('keepdims', 1)]
  )

  // GraphProto: node=1, name=2, input=11, output=12
  const graph = [
    ...lenField(1, castNode),
    ...lenField(1, meanNode),
    ...strField(2, 'reranker_fixture'),
    ...lenField(11, tensorValueInfo('input_ids', ELEM_INT64, ['batch', 'seq'])),
    ...lenField(11, tensorValueInfo('attention_mask', ELEM_INT64, ['batch', 'seq'])),
    ...lenField(12, tensorValueInfo('logits', ELEM_FLOAT, ['batch', 1]))
  ]

  // OperatorSetIdProto: domain=1 (default ""), version=2
  const opset = varintField(2, 13)

  // ModelProto: ir_version=1, opset_import=8, graph=7
  const model = [...varintField(1, 8), ...lenField(7, graph), ...lenField(8, opset)]
  return Buffer.from(model)
}
