export function native(value, type, named, depth = 0) {
  if (depth > 128) throw Error('Input nesting exceeds 128 levels.');
  switch (type.kind) {
    case 'u32':
    case 'i32':
      return Number(value);
    case 'u64':
    case 'i64':
      return BigInt(value);
    case 'int':
      return BigInt(value.Int);
    case 'f32':
      return value && typeof value === 'object'
        ? { F32Bits: Number(value.F32Bits) }
        : Number(value);
    case 'f64':
      return value && typeof value === 'object'
        ? { F64Bits: String(value.F64Bits) }
        : Number(value);
    case 'list':
    case 'vector':
      return value.map((item) => native(item, type.element, named, depth + 1));
    case 'record':
      return Object.fromEntries(
        type.fields.map((field) => [
          field.name,
          native(value[field.name], field.type, named, depth + 1),
        ]),
      );
    case 'ref':
      return native(value, named[type.name], named, depth + 1);
    case 'option':
      return Object.hasOwn(value, 'Some')
        ? { Some: native(value.Some, type.element, named, depth + 1) }
        : { None: null };
    case 'result':
      return Object.hasOwn(value, 'Ok')
        ? { Ok: native(value.Ok, type.ok, named, depth + 1) }
        : { Err: native(value.Err, type.error, named, depth + 1) };
    case 'unit':
    case 'bool':
    case 'string':
    case 'id':
    case 'enum':
      return value;
    default:
      throw Error('Unsupported public value descriptor: ' + type.kind);
  }
}
