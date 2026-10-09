//! Hand-rolled protobuf for `FenderMessageTMS`: a dozen fields, no schema compiler.

fn put_varint(out: &mut Vec<u8>, mut n: u64) {
    loop {
        let b = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

pub fn varint_field(out: &mut Vec<u8>, field: u32, value: u64) {
    put_varint(out, u64::from(field) << 3);
    put_varint(out, value);
}

pub fn bytes_field(out: &mut Vec<u8>, field: u32, value: &[u8]) {
    put_varint(out, (u64::from(field) << 3) | 2);
    put_varint(out, value.len() as u64);
    out.extend_from_slice(value);
}

pub fn nested(field: u32, inner: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    bytes_field(&mut out, field, inner);
    out
}

#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Varint(u64),
    Bytes(Vec<u8>),
    Fixed,
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut n = 0u64;
    for shift in (0..64).step_by(7) {
        let b = *buf.get(*pos)?;
        *pos += 1;
        n |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Some(n);
        }
    }
    None
}

/// `(field, value)` pairs; stops at the first malformed field.
pub fn parse(buf: &[u8]) -> Vec<(u32, Val)> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < buf.len() {
        let Some(tag) = read_varint(buf, &mut pos) else {
            break;
        };
        let field = (tag >> 3) as u32;
        let val = match tag & 7 {
            0 => match read_varint(buf, &mut pos) {
                Some(v) => Val::Varint(v),
                None => break,
            },
            1 | 5 => {
                pos += if tag & 7 == 1 { 8 } else { 4 };
                Val::Fixed
            }
            2 => {
                let Some(len) = read_varint(buf, &mut pos) else {
                    break;
                };
                let Some(end) = pos.checked_add(len as usize).filter(|e| *e <= buf.len()) else {
                    break;
                };
                let v = buf[pos..end].to_vec();
                pos = end;
                Val::Bytes(v)
            }
            _ => break,
        };
        out.push((field, val));
    }
    out
}

pub fn get_bytes(fields: &[(u32, Val)], field: u32) -> Option<&[u8]> {
    fields.iter().find_map(|(f, v)| match v {
        Val::Bytes(b) if *f == field => Some(b.as_slice()),
        _ => None,
    })
}

pub fn get_varint(fields: &[(u32, Val)], field: u32) -> Option<u64> {
    fields.iter().find_map(|(f, v)| match v {
        Val::Varint(n) if *f == field => Some(*n),
        _ => None,
    })
}
