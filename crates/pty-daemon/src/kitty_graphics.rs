//! Kitty graphics protocol (https://sw.kovidgoyal.net/kitty/graphics-protocol/).
//!
//! Programs send images as APC sequences: `ESC _G <key=value,...> ; <base64> ESC \`.
//! The UI already renders iTerm2 inline images (OSC 1337 File=) — in blocks as real
//! <img> elements, in TUIs through xterm's image addon — so the daemon translates:
//! it assembles chunked transmissions, decodes them to PNG, keeps transmitted images
//! by id (for later `a=p` placements), answers queries, and replaces each displayed
//! image with an equivalent OSC 1337 sequence in the output stream.
//!
//! Supported: actions t/T/p/q/d, formats 24/32/100, transmission d (direct),
//! f (file), t (temp file, deleted after reading), zlib compression (o=z), quiet
//! (q=1/2), display size in cells (c/r). Not supported: shared memory (t=s), unicode
//! placeholders (U=1, stored but not shown), animation, z-index, and removing an image
//! that's already on screen (`a=d` only forgets stored images).

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::collections::{HashMap, VecDeque};
use std::io::Read;

/// Cap on stored (transmitted, not yet discarded) image data per session.
const STORE_LIMIT: usize = 64 << 20;
/// Cap on a single image, decoded.
const IMAGE_LIMIT: usize = 64 << 20;

#[derive(Default, Clone)]
struct Ctrl {
    action: char,
    format: u32,
    medium: char,
    compression: Option<char>,
    width: u32,
    height: u32,
    id: u32,
    number: u32,
    placement: u32,
    more: bool,
    quiet: u8,
    cols: u32,
    rows: u32,
    placeholder: bool,
    delete: char,
}

impl Ctrl {
    fn parse(s: &str) -> Self {
        let mut c = Ctrl { action: 't', format: 32, medium: 'd', delete: 'a', ..Default::default() };
        for kv in s.split(',') {
            let Some((k, v)) = kv.split_once('=') else { continue };
            let n = || v.parse::<u32>().unwrap_or(0);
            let ch = || v.chars().next().unwrap_or('\0');
            match k {
                "a" => c.action = ch(),
                "f" => c.format = n(),
                "t" => c.medium = ch(),
                "o" => c.compression = Some(ch()),
                "s" => c.width = n(),
                "v" => c.height = n(),
                "i" => c.id = n(),
                "I" => c.number = n(),
                "p" => c.placement = n(),
                "m" => c.more = v == "1",
                "q" => c.quiet = n() as u8,
                "c" => c.cols = n(),
                "r" => c.rows = n(),
                "U" => c.placeholder = v == "1",
                "d" => c.delete = ch(),
                _ => {}
            }
        }
        c
    }
}

struct Image {
    png: Vec<u8>,
}

/// Per-session protocol state.
#[derive(Default)]
pub struct KittyGraphics {
    images: HashMap<u32, Image>,
    order: VecDeque<u32>,
    stored_bytes: usize,
    numbers: HashMap<u32, u32>, // I= image number → id
    next_id: u32,
    pending: Option<(Ctrl, String)>, // chunked transmission: first chunk's keys + base64 so far
}

/// What to do with one graphics command.
pub struct Outcome {
    /// Text that replaces the APC sequence in the output stream (an OSC 1337 image, or nothing).
    pub output: String,
    /// Bytes to write back to the PTY (the protocol's response), if any.
    pub reply: Option<String>,
}

impl KittyGraphics {
    /// Replace every complete `ESC _ … ESC \` in `s`: graphics commands are handled,
    /// other APC strings dropped. Returns the new text and any replies for the PTY.
    pub fn process(&mut self, s: &str) -> (String, Vec<String>) {
        if !s.contains("\x1b_") {
            return (s.to_string(), vec![]);
        }
        let mut out = String::with_capacity(s.len());
        let mut replies = vec![];
        let mut rest = s;
        while let Some(start) = rest.find("\x1b_") {
            out.push_str(&rest[..start]);
            let body_start = start + 2;
            let Some(len) = rest[body_start..].find("\x1b\\") else {
                // Unterminated (the reader holds these back, so only at a size cap): drop.
                rest = "";
                break;
            };
            let body = &rest[body_start..body_start + len];
            if let Some(cmd) = body.strip_prefix('G') {
                let o = self.handle(cmd);
                out.push_str(&o.output);
                replies.extend(o.reply);
            }
            rest = &rest[body_start + len + 2..];
        }
        out.push_str(rest);
        (out, replies)
    }

    /// Handle one command (the APC body after `G`).
    pub fn handle(&mut self, cmd: &str) -> Outcome {
        let (keys, payload) = cmd.split_once(';').unwrap_or((cmd, ""));
        let keys = Ctrl::parse(keys);

        // Continuation of a chunked transmission: only m (and q) are meaningful.
        if let Some((first, mut data)) = self.pending.take() {
            data.push_str(payload);
            if keys.more {
                if data.len() > IMAGE_LIMIT * 4 / 3 + 4 {
                    return self.respond(&first, Err("EFBIG:image too large".into()));
                }
                self.pending = Some((first, data));
                return Outcome { output: String::new(), reply: None };
            }
            return self.finish(first, &data);
        }

        match keys.action {
            'd' | 'D' => {
                self.delete(&keys);
                Outcome { output: String::new(), reply: None }
            }
            'p' => {
                let id = self.resolve_id(&keys);
                match self.images.get(&id) {
                    Some(img) => {
                        let output = iterm_image(&img.png, &keys);
                        let mut o = self.respond(&keys, Ok(id));
                        o.output = output;
                        o
                    }
                    None => self.respond(&keys, Err("ENOENT:no such image".into())),
                }
            }
            't' | 'T' | 'q' => {
                if keys.more {
                    self.pending = Some((keys, payload.to_string()));
                    return Outcome { output: String::new(), reply: None };
                }
                self.finish(keys, payload)
            }
            _ => self.respond(&keys, Err("EINVAL:unsupported action".into())),
        }
    }

    fn finish(&mut self, keys: Ctrl, b64: &str) -> Outcome {
        let png = match decode(&keys, b64) {
            Ok(png) => png,
            Err(e) => return self.respond(&keys, Err(e)),
        };
        if keys.action == 'q' {
            // Query: validate only, never store or show.
            return self.respond(&keys, Ok(keys.id));
        }
        let id = self.assign_id(&keys);
        let output = if keys.action == 'T' && !keys.placeholder { iterm_image(&png, &keys) } else { String::new() };
        self.store(id, png);
        let mut o = self.respond(&keys, Ok(id));
        o.output = output;
        o
    }

    fn assign_id(&mut self, keys: &Ctrl) -> u32 {
        if keys.id != 0 {
            return keys.id;
        }
        // Ids we hand out ourselves count down from the top so they don't collide with
        // the client's (which count up from 1).
        self.next_id = self.next_id.wrapping_sub(1);
        if self.next_id == 0 {
            self.next_id = u32::MAX;
        }
        if keys.number != 0 {
            self.numbers.insert(keys.number, self.next_id);
        }
        self.next_id
    }

    fn resolve_id(&self, keys: &Ctrl) -> u32 {
        if keys.id != 0 { keys.id } else { self.numbers.get(&keys.number).copied().unwrap_or(0) }
    }

    fn store(&mut self, id: u32, png: Vec<u8>) {
        if let Some(old) = self.images.remove(&id) {
            self.stored_bytes -= old.png.len();
            self.order.retain(|x| *x != id);
        }
        self.stored_bytes += png.len();
        self.images.insert(id, Image { png });
        self.order.push_back(id);
        while self.stored_bytes > STORE_LIMIT {
            let Some(old) = self.order.pop_front() else { break };
            if let Some(img) = self.images.remove(&old) {
                self.stored_bytes -= img.png.len();
            }
        }
    }

    fn delete(&mut self, keys: &Ctrl) {
        match keys.delete.to_ascii_lowercase() {
            // Deleting by id/number forgets the stored image; other targets (by cell,
            // column, z-index …) only concern what's on screen, which we can't remove.
            'i' | 'n' => {
                let id = self.resolve_id(keys);
                if let Some(img) = self.images.remove(&id) {
                    self.stored_bytes -= img.png.len();
                    self.order.retain(|x| *x != id);
                }
            }
            'a' if keys.delete == 'A' => {
                self.images.clear();
                self.order.clear();
                self.numbers.clear();
                self.stored_bytes = 0;
            }
            _ => {}
        }
    }

    /// The protocol's response. Only sent when the client named the image (i= or I=),
    /// and filtered by q= (1: errors only, 2: nothing).
    fn respond(&self, keys: &Ctrl, result: Result<u32, String>) -> Outcome {
        let named = keys.id != 0 || keys.number != 0;
        let reply = match (&result, keys.quiet) {
            _ if !named => None,
            (_, 2) | (Ok(_), 1) => None,
            _ => {
                let mut ids = vec![];
                if keys.id != 0 { ids.push(format!("i={}", keys.id)); }
                if keys.number != 0 {
                    if let Ok(id) = result { ids.push(format!("i={id}")); }
                    ids.push(format!("I={}", keys.number));
                }
                if keys.placement != 0 { ids.push(format!("p={}", keys.placement)); }
                let msg = match &result { Ok(_) => "OK".to_string(), Err(e) => e.clone() };
                Some(format!("\x1b_G{};{}\x1b\\", ids.join(","), msg))
            }
        };
        Outcome { output: String::new(), reply }
    }
}

/// Payload → PNG bytes.
fn decode(keys: &Ctrl, b64: &str) -> Result<Vec<u8>, String> {
    let raw = B64.decode(b64.trim().as_bytes()).map_err(|_| "EINVAL:bad base64".to_string())?;
    let data = match keys.medium {
        'd' => raw,
        'f' | 't' => {
            let path = String::from_utf8(raw).map_err(|_| "EINVAL:bad path".to_string())?;
            let meta = std::fs::metadata(&path).map_err(|e| format!("EBADF:{e}"))?;
            if !meta.is_file() || meta.len() as usize > IMAGE_LIMIT {
                return Err("EBADF:not a regular file or too large".into());
            }
            let bytes = std::fs::read(&path).map_err(|e| format!("EBADF:{e}"))?;
            // Temporary files are ours to delete — but only ones that look like it.
            if keys.medium == 't' && path.contains("tty-graphics-protocol") {
                let _ = std::fs::remove_file(&path);
            }
            bytes
        }
        's' => return Err("EINVAL:shared memory transmission is not supported".into()),
        _ => return Err("EINVAL:unknown transmission medium".into()),
    };
    let data = match keys.compression {
        None => data,
        Some('z') => {
            let mut out = vec![];
            flate2::read::ZlibDecoder::new(&data[..])
                .take(IMAGE_LIMIT as u64 + 1)
                .read_to_end(&mut out)
                .map_err(|_| "EINVAL:bad zlib data".to_string())?;
            if out.len() > IMAGE_LIMIT {
                return Err("EFBIG:image too large".into());
            }
            out
        }
        Some(_) => return Err("EINVAL:unknown compression".into()),
    };
    match keys.format {
        100 => {
            if !data.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Err("EBADPNG:not a PNG".into());
            }
            Ok(data)
        }
        24 | 32 => {
            let (w, h) = (keys.width, keys.height);
            let bpp = if keys.format == 24 { 3 } else { 4 };
            if w == 0 || h == 0 || (w as usize) * (h as usize) * bpp != data.len() {
                return Err("EINVAL:size doesn't match data".into());
            }
            encode_png(&data, w, h, keys.format == 32).map_err(|e| format!("EINVAL:{e}"))
        }
        _ => Err("EINVAL:unknown format".into()),
    }
}

fn encode_png(pixels: &[u8], w: u32, h: u32, alpha: bool) -> Result<Vec<u8>, png::EncodingError> {
    let mut out = vec![];
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(if alpha { png::ColorType::Rgba } else { png::ColorType::Rgb });
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        enc.write_header()?.write_image_data(pixels)?;
    }
    Ok(out)
}

/// The equivalent iTerm2 inline image (what the UI renders).
fn iterm_image(png: &[u8], keys: &Ctrl) -> String {
    let mut args = format!("inline=1;size={};preserveAspectRatio=1", png.len());
    if keys.cols != 0 { args.push_str(&format!(";width={}", keys.cols)); }
    if keys.rows != 0 { args.push_str(&format!(";height={}", keys.rows)); }
    format!("\x1b]1337;File={args}:{}\x07", B64.encode(png))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_1x1() -> Vec<u8> { encode_png(&[255, 0, 0, 255], 1, 1, true).unwrap() }

    #[test]
    fn direct_png_is_shown_and_acknowledged() {
        let mut g = KittyGraphics::default();
        let b64 = B64.encode(png_1x1());
        let (out, replies) = g.process(&format!("a\x1b_Ga=T,f=100,i=7;{b64}\x1b\\b"));
        assert!(out.starts_with("a\x1b]1337;File=inline=1;"), "{out:?}");
        assert!(out.ends_with("\x07b"));
        assert_eq!(replies, vec!["\x1b_Gi=7;OK\x1b\\".to_string()]);
    }

    #[test]
    fn chunked_raw_rgba_and_placement() {
        let mut g = KittyGraphics::default();
        let b64 = B64.encode([0u8, 0, 255, 255, 0, 255, 0, 255]); // 2x1 RGBA
        let (a, b) = b64.split_at(4);
        assert_eq!(g.process(&format!("\x1b_Ga=t,f=32,s=2,v=1,i=3,q=1,m=1;{a}\x1b\\")).0, "");
        let (out, replies) = g.process(&format!("\x1b_Gm=0;{b}\x1b\\"));
        assert_eq!(out, ""); // a=t only transmits
        assert!(replies.is_empty()); // q=1 suppresses OK
        let (out, _) = g.process("\x1b_Ga=p,i=3,c=4,r=2\x1b\\");
        assert!(out.contains(";width=4;height=2:"), "{out:?}");
    }

    #[test]
    fn query_and_errors() {
        let mut g = KittyGraphics::default();
        let (_, r) = g.process("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\");
        assert_eq!(r, vec!["\x1b_Gi=31;OK\x1b\\".to_string()]);
        let (_, r) = g.process("\x1b_Ga=p,i=99\x1b\\");
        assert!(r[0].starts_with("\x1b_Gi=99;ENOENT"));
        // No id → no response; non-graphics APC is dropped.
        let (out, r) = g.process("x\x1b_Ga=p\x1b\\\x1b_other\x1b\\y");
        assert_eq!((out.as_str(), r.len()), ("xy", 0));
    }
}
