//! Windows taskbar overlay for the learning plugin's homework count.
#[cfg(any(target_os = "windows", test))]
fn badge_rgba(count: u32) -> Vec<u8> {
    const DIGITS: [[u8; 5]; 11] = [
        [7,5,5,5,7], [2,6,2,2,7], [7,1,7,4,7], [7,1,7,1,7],
        [5,5,7,1,1], [7,4,7,1,7], [7,4,7,5,7], [7,1,1,1,1],
        [7,5,7,5,7], [7,5,7,1,7], [0,2,7,2,0],
    ];
    let text = if count > 99 { "99+".to_string() } else { count.to_string() };
    let scale = if text.len() == 1 { 3 } else { 2 };
    let width = (text.len() * 4 - 1) * scale;
    let mut pixels = vec![0; 24 * 24 * 4];
    for y in 0..24i32 {
        for x in 0..24i32 {
            if (2*x-23).pow(2) + (2*y-23).pow(2) <= 23*23 {
                let at = (y as usize * 24 + x as usize) * 4;
                pixels[at..at+4].copy_from_slice(&[218, 55, 66, 255]);
            }
        }
    }
    for (i, ch) in text.bytes().enumerate() {
        let glyph = DIGITS[if ch == b'+' { 10 } else { (ch - b'0') as usize }];
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..3 {
                if bits & (1 << (2-col)) == 0 { continue; }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let x = (24-width)/2 + (i*4+col)*scale + dx;
                        let y = (24-5*scale)/2 + row*scale + dy;
                        let at = (y*24+x)*4;
                        pixels[at..at+4].copy_from_slice(&[255,255,255,255]);
                    }
                }
            }
        }
    }
    pixels
}

#[tauri::command]
pub fn set_taskbar_badge(app: tauri::AppHandle, count: u32) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
        let icon = (count > 0).then(|| tauri::image::Image::new_owned(badge_rgba(count), 24, 24));
        window.set_overlay_icon(icon).map_err(|error| error.to_string())?;
        Ok(true)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, count);
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renders_counts_and_caps_large_values() {
        for n in [1,9,10,99,100,u32::MAX] {
            let pixels = badge_rgba(n);
            assert_eq!(pixels.len(), 24*24*4);
            assert_eq!(&pixels[..4], &[0,0,0,0]);
            assert!(pixels.chunks_exact(4).any(|p| p == [255,255,255,255]));
        }
        assert_ne!(badge_rgba(1), badge_rgba(2));
        assert_eq!(badge_rgba(100), badge_rgba(u32::MAX));
    }
}
