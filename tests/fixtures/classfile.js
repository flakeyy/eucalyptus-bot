// Builds a minimal Java classfile for tests.
//   modMarker    - plant a Forge @Mod descriptor string in the constant pool
//   initNewClass - emit `new <class>; pop; return` in <clinit> (eager client ref)
//   interfaces   - interface class names the class implements
function makeClassFile({
  className,
  superName = "java/lang/Object",
  interfaces = [],
  modMarker = false,
  initNewClass = null
}) {
  const strings = [ className, superName, ...interfaces ];
  if (modMarker) strings.push("Lcpw/mods/fml/common/Mod;");
  if (initNewClass) strings.push(initNewClass, "<clinit>", "()V", "Code");

  const utf8Index = new Map();
  const cp = []; // 1-based entries as buffers
  const addUtf8 = s => {
    if (utf8Index.has(s)) return utf8Index.get(s);
    const bytes = Buffer.from(s, "utf8");
    const entry = Buffer.alloc(3 + bytes.length);
    entry[0] = 1;
    entry.writeUInt16BE(bytes.length, 1);
    bytes.copy(entry, 3);
    cp.push(entry);
    const idx = cp.length;
    utf8Index.set(s, idx);
    return idx;
  };
  const addClass = name => {
    const u = addUtf8(name);
    const entry = Buffer.alloc(3);
    entry[0] = 7;
    entry.writeUInt16BE(u, 1);
    cp.push(entry);
    return cp.length;
  };

  for (const s of strings) addUtf8(s);
  const thisIdx = addClass(className);
  const superIdx = addClass(superName);
  const ifaceIdxs = interfaces.map(addClass);
  let initNewIdx = null;
  if (initNewClass) initNewIdx = addClass(initNewClass);

  const methods = [];
  if (initNewClass) {
    // Code: new #initNewIdx; pop; return
    const codeBytes = Buffer.from([ 187, (initNewIdx >> 8) & 0xff, initNewIdx & 0xff, 87, 177 ]);
    const codeAttr = Buffer.alloc(2 + 4 + 2 + 2 + 4 + codeBytes.length + 2 + 2);
    let o = 0;
    codeAttr.writeUInt16BE(addUtf8("Code"), o); o += 2;
    const codeAttrLenPos = o; o += 4;
    codeAttr.writeUInt16BE(2, o); o += 2; // max_stack
    codeAttr.writeUInt16BE(0, o); o += 2; // max_locals
    codeAttr.writeUInt32BE(codeBytes.length, o); o += 4;
    codeBytes.copy(codeAttr, o); o += codeBytes.length;
    codeAttr.writeUInt16BE(0, o); o += 2; // exception_table_length
    codeAttr.writeUInt16BE(0, o); o += 2; // attributes_count
    codeAttr.writeUInt32BE(o - codeAttrLenPos - 4, codeAttrLenPos);

    const method = Buffer.alloc(8 + codeAttr.length);
    method.writeUInt16BE(0x0008, 0); // ACC_STATIC
    method.writeUInt16BE(addUtf8("<clinit>"), 2);
    method.writeUInt16BE(addUtf8("()V"), 4);
    method.writeUInt16BE(1, 6); // one attribute
    codeAttr.copy(method, 8);
    methods.push(method);
  }

  const cpCount = cp.length + 1;
  const header = Buffer.alloc(10);
  header.writeUInt32BE(0xCAFEBABE, 0);
  header.writeUInt16BE(0x0031, 4); // Java 5
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(cpCount, 8);

  const afterCp = Buffer.alloc(6 + 2 + ifaceIdxs.length * 2);
  afterCp.writeUInt16BE(0x0021, 0); // ACC_PUBLIC ACC_SUPER
  afterCp.writeUInt16BE(thisIdx, 2);
  afterCp.writeUInt16BE(superIdx, 4);
  afterCp.writeUInt16BE(ifaceIdxs.length, 6);
  ifaceIdxs.forEach((idx, i) => afterCp.writeUInt16BE(idx, 8 + i * 2));

  const fieldCount = Buffer.alloc(2);
  const methodCount = Buffer.alloc(2);
  methodCount.writeUInt16BE(methods.length, 0);
  const classAttrs = Buffer.alloc(2);

  return Buffer.concat([ header, ...cp, afterCp, fieldCount, methodCount, ...methods, classAttrs ]);
}

module.exports = { makeClassFile };
