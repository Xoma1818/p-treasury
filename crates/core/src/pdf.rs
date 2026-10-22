//! Простой PDF на чистом Rust: страницы A4, текст и линии. Кириллица —
//! встроенным шрифтом DejaVu Sans Condensed (лицензия в `assets/fonts`):
//! в файл кладётся только подмножество нужных знаков (CID-шрифт Identity-H
//! с таблицей ToUnicode, чтобы текст можно было найти и скопировать).

use std::collections::BTreeMap;

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream, StringFormat};

use crate::{Error, Result};

/// DejaVu Sans Condensed 2.37, лицензия Bitstream Vera / public domain.
const FONT: &[u8] = include_bytes!("../assets/fonts/DejaVuSansCondensed.ttf");
const FONT_NAME: &str = "DejaVuSansCondensed";

/// Размер A4 в пунктах.
pub const A4_WIDTH: f32 = 595.28;
pub const A4_HEIGHT: f32 = 841.89;

#[derive(Debug, Clone)]
enum Item {
    Text {
        x: f32,
        y: f32,
        size: f32,
        text: String,
    },
    Line {
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        width: f32,
    },
    Fill {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        gray: f32,
    },
}

/// Выравнивание текста относительно `x`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Right,
    Center,
}

fn pdf_err(e: impl std::fmt::Display) -> Error {
    Error::Validation(format!("не удалось записать PDF: {e}"))
}

/// Документ из страниц A4. Координаты в пунктах, `y` — от верха страницы.
pub struct Pdf {
    face: ttf_parser::Face<'static>,
    pages: Vec<Vec<Item>>,
    title: String,
}

impl Pdf {
    pub fn new(title: &str) -> Self {
        Pdf {
            face: ttf_parser::Face::parse(FONT, 0).expect("встроенный шрифт читается"),
            pages: Vec::new(),
            title: title.to_string(),
        }
    }

    pub fn add_page(&mut self) {
        self.pages.push(Vec::new());
    }

    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    fn page(&mut self) -> &mut Vec<Item> {
        if self.pages.is_empty() {
            self.pages.push(Vec::new());
        }
        self.pages.last_mut().expect("страница есть")
    }

    /// Есть ли знак в шрифте.
    pub fn has_char(&self, c: char) -> bool {
        self.face.glyph_index(c).is_some()
    }

    /// Ширина текста в пунктах.
    pub fn width(&self, text: &str, size: f32) -> f32 {
        let upem = self.face.units_per_em() as f32;
        let units: f32 = text
            .chars()
            .map(|c| {
                self.face
                    .glyph_index(c)
                    .and_then(|g| self.face.glyph_hor_advance(g))
                    .unwrap_or(0) as f32
            })
            .sum();
        units * size / upem
    }

    /// Текст на текущей странице; `y` — базовая линия от верха страницы.
    pub fn text(&mut self, x: f32, y: f32, size: f32, align: Align, text: &str) {
        let w = self.width(text, size);
        let x = match align {
            Align::Left => x,
            Align::Right => x - w,
            Align::Center => x - w / 2.0,
        };
        self.page().push(Item::Text {
            x,
            y,
            size,
            text: text.to_string(),
        });
    }

    /// Текст на указанной странице (например, номера страниц после вёрстки).
    pub fn text_on(&mut self, page: usize, x: f32, y: f32, size: f32, align: Align, text: &str) {
        let w = self.width(text, size);
        let x = match align {
            Align::Left => x,
            Align::Right => x - w,
            Align::Center => x - w / 2.0,
        };
        self.pages[page].push(Item::Text {
            x,
            y,
            size,
            text: text.to_string(),
        });
    }

    pub fn line(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, width: f32) {
        self.page().push(Item::Line {
            x1,
            y1,
            x2,
            y2,
            width,
        });
    }

    /// Серый прямоугольник (фон шапки таблицы); `gray` от 0 (чёрный) до 1 (белый).
    pub fn fill(&mut self, x: f32, y: f32, w: f32, h: f32, gray: f32) {
        self.page().push(Item::Fill { x, y, w, h, gray });
    }

    /// Собрать файл PDF.
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        let face = &self.face;
        // Знаки → номера глифов; в подмножестве они перенумерованы подряд.
        let mut remapper = subsetter::GlyphRemapper::new();
        let mut unicode: BTreeMap<u16, char> = BTreeMap::new();
        let mut widths: BTreeMap<u16, u32> = BTreeMap::new();
        let upem = face.units_per_em() as u32;
        let mut glyph = |c: char| -> u16 {
            let g = face.glyph_index(c).map_or(0, |g| g.0);
            let new = remapper.remap(g);
            unicode.entry(new).or_insert(c);
            let adv = face.glyph_hor_advance(ttf_parser::GlyphId(g)).unwrap_or(0) as u32;
            widths.insert(new, adv * 1000 / upem);
            new
        };
        let mut contents: Vec<Vec<u8>> = Vec::with_capacity(self.pages.len());
        for page in &self.pages {
            let mut ops = Vec::new();
            for item in page {
                match item {
                    Item::Fill { x, y, w, h, gray } => {
                        ops.push(Operation::new("q", vec![]));
                        ops.push(Operation::new("g", vec![(*gray).into()]));
                        ops.push(Operation::new(
                            "re",
                            vec![
                                (*x).into(),
                                (A4_HEIGHT - y - h).into(),
                                (*w).into(),
                                (*h).into(),
                            ],
                        ));
                        ops.push(Operation::new("f", vec![]));
                        ops.push(Operation::new("Q", vec![]));
                    }
                    Item::Line {
                        x1,
                        y1,
                        x2,
                        y2,
                        width,
                    } => {
                        ops.push(Operation::new("w", vec![(*width).into()]));
                        ops.push(Operation::new(
                            "m",
                            vec![(*x1).into(), (A4_HEIGHT - y1).into()],
                        ));
                        ops.push(Operation::new(
                            "l",
                            vec![(*x2).into(), (A4_HEIGHT - y2).into()],
                        ));
                        ops.push(Operation::new("S", vec![]));
                    }
                    Item::Text { x, y, size, text } => {
                        let mut bytes = Vec::with_capacity(text.len() * 2);
                        for c in text.chars() {
                            bytes.extend_from_slice(&glyph(c).to_be_bytes());
                        }
                        ops.push(Operation::new("BT", vec![]));
                        ops.push(Operation::new("Tf", vec!["F1".into(), (*size).into()]));
                        ops.push(Operation::new(
                            "Td",
                            vec![(*x).into(), (A4_HEIGHT - y).into()],
                        ));
                        ops.push(Operation::new(
                            "Tj",
                            vec![Object::String(bytes, StringFormat::Hexadecimal)],
                        ));
                        ops.push(Operation::new("ET", vec![]));
                    }
                }
            }
            contents.push(Content { operations: ops }.encode().map_err(pdf_err)?);
        }
        let font_data = subsetter::subset(FONT, 0, &remapper).map_err(pdf_err)?;

        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let mut file = Stream::new(
            dictionary! { "Length1" => font_data.len() as i64 },
            font_data,
        );
        file.compress().map_err(pdf_err)?;
        let file_id = doc.add_object(file);
        let scale = |v: i16| (v as i64) * 1000 / upem as i64;
        let bbox = face.global_bounding_box();
        let base_font = format!("PTRSRY+{FONT_NAME}");
        let descriptor_id = doc.add_object(dictionary! {
            "Type" => "FontDescriptor",
            "FontName" => Object::Name(base_font.clone().into_bytes()),
            "Flags" => 32,
            "FontBBox" => vec![
                scale(bbox.x_min).into(),
                scale(bbox.y_min).into(),
                scale(bbox.x_max).into(),
                scale(bbox.y_max).into(),
            ],
            "ItalicAngle" => 0,
            "Ascent" => scale(face.ascender()),
            "Descent" => scale(face.descender()),
            "CapHeight" => scale(face.capital_height().unwrap_or(face.ascender())),
            "StemV" => 80,
            "FontFile2" => file_id,
        });
        let w: Vec<Object> = widths
            .iter()
            .flat_map(|(g, w)| [Object::Integer(*g as i64), vec![Object::Integer(*w as i64)].into()])
            .collect();
        let cid_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "CIDFontType2",
            "BaseFont" => Object::Name(base_font.clone().into_bytes()),
            "CIDSystemInfo" => dictionary! {
                "Registry" => Object::string_literal("Adobe"),
                "Ordering" => Object::string_literal("Identity"),
                "Supplement" => 0,
            },
            "FontDescriptor" => descriptor_id,
            "DW" => 500,
            "W" => w,
            "CIDToGIDMap" => "Identity",
        });
        let mut cmap = Stream::new(dictionary! {}, to_unicode(&unicode).into_bytes());
        cmap.compress().map_err(pdf_err)?;
        let cmap_id = doc.add_object(cmap);
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type0",
            "BaseFont" => Object::Name(base_font.into_bytes()),
            "Encoding" => "Identity-H",
            "DescendantFonts" => vec![cid_id.into()],
            "ToUnicode" => cmap_id,
        });
        let resources_id = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        let mut kids = Vec::with_capacity(contents.len());
        for content in contents {
            let mut stream = Stream::new(dictionary! {}, content);
            stream.compress().map_err(pdf_err)?;
            let content_id = doc.add_object(stream);
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content_id,
                "Resources" => resources_id,
                "MediaBox" => vec![0.into(), 0.into(), A4_WIDTH.into(), A4_HEIGHT.into()],
            });
            kids.push(page_id.into());
        }
        let count = kids.len() as i64;
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => count,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        let info_id = doc.add_object(dictionary! {
            "Title" => Object::String(utf16(&self.title), StringFormat::Hexadecimal),
            "Producer" => Object::string_literal("P-Treasury"),
        });
        doc.trailer.set("Root", catalog_id);
        doc.trailer.set("Info", info_id);
        let mut out = Vec::new();
        doc.save_to(&mut out).map_err(pdf_err)?;
        Ok(out)
    }
}

/// Строка PDF в UTF-16BE с меткой порядка байтов (для заголовка документа).
fn utf16(s: &str) -> Vec<u8> {
    let mut out = vec![0xFE, 0xFF];
    for u in s.encode_utf16() {
        out.extend_from_slice(&u.to_be_bytes());
    }
    out
}

/// Таблица ToUnicode: номер глифа → знак.
fn to_unicode(map: &BTreeMap<u16, char>) -> String {
    let mut s = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
         /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
         /CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n\
         1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
    );
    let entries: Vec<_> = map.iter().collect();
    for chunk in entries.chunks(100) {
        s.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (g, c) in chunk {
            let hex: String = c
                .encode_utf16(&mut [0u16; 2])
                .iter()
                .map(|u| format!("{u:04X}"))
                .collect();
            s.push_str(&format!("<{:04X}> <{hex}>\n", g));
        }
        s.push_str("endbfchar\n");
    }
    s.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    s
}
