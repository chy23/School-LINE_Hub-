import os
import base64
from PIL import Image

SVG_CONTENT = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs>
    <!-- Background Gradient: LINE Green to School Emerald -->
    <linearGradient id="hubBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#06C755"/>
      <stop offset="40%" stop-color="#10B981"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>

    <!-- Glass Top Curvature Highlight -->
    <linearGradient id="glassTop" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>

    <!-- Golden Accent Gradient -->
    <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FDE047"/>
      <stop offset="50%" stop-color="#F59E0B"/>
      <stop offset="100%" stop-color="#D97706"/>
    </linearGradient>

    <!-- Soft Depth Shadow -->
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#064e3b" flood-opacity="0.45"/>
    </filter>
  </defs>

  <!-- Apple Squircle Outer Container -->
  <rect width="512" height="512" rx="115" fill="url(#hubBg)"/>
  <rect width="512" height="260" rx="115" fill="url(#glassTop)"/>
  <rect x="2" y="2" width="508" height="508" rx="113" fill="none" stroke="#ffffff" stroke-width="4" stroke-opacity="0.3"/>

  <!-- Main Central Motif: Pure White Crisp Speech Bubble -->
  <g filter="url(#shadow)">
    <!-- Speech bubble body + tail -->
    <path d="M 120 100 
             L 392 100 
             A 64 64 0 0 1 456 164 
             L 456 316 
             A 64 64 0 0 1 392 380 
             L 210 380 
             L 124 436 
             A 12 12 0 0 1 104 426 
             L 106 380 
             A 64 64 0 0 1 56 316 
             L 56 164 
             A 64 64 0 0 1 120 100 Z" 
          fill="#FFFFFF" />

    <!-- Inside Content: Educational Graduation Cap (School) + Hub Broadcasting Pulse -->
    <!-- School Mortarboard Cap (Deep Slate / Navy) -->
    <g transform="translate(0, -6)">
      <!-- Cap Base Skullcap -->
      <path d="M 204 250 Q 256 278, 308 250 L 308 268 Q 256 296, 204 268 Z" fill="#1E293B"/>

      <!-- Diamond Board -->
      <polygon points="256,170 366,212 256,254 146,212" fill="#0F172A"/>
      <polygon points="256,178 350,212 256,246 162,212" fill="#1E293B"/>

      <!-- Center Gold Button -->
      <circle cx="256" cy="212" r="8" fill="url(#goldGrad)"/>

      <!-- Golden Tassel hanging right -->
      <path d="M 256 212 Q 312 218, 332 252" fill="none" stroke="#F59E0B" stroke-width="5" stroke-linecap="round"/>
      <polygon points="328,250 338,280 324,280" fill="url(#goldGrad)"/>
    </g>

    <!-- Hub Broadcasting Pulse Rings (Broadcasting notifications to parents) -->
    <g fill="none" stroke="#059669" stroke-linecap="round">
      <!-- Wave 1 (Inner Left & Right) -->
      <path d="M 174 308 A 48 48 0 0 1 174 340" stroke-width="7"/>
      <path d="M 338 308 A 48 48 0 0 0 338 340" stroke-width="7"/>
      
      <!-- Wave 2 (Middle Left & Right) -->
      <path d="M 148 296 A 76 76 0 0 1 148 352" stroke-width="7" opacity="0.75"/>
      <path d="M 364 296 A 76 76 0 0 0 364 352" stroke-width="7" opacity="0.75"/>
    </g>

    <!-- Central Signal Core / Notification Badge Dot -->
    <circle cx="256" cy="324" r="14" fill="#06C755"/>
    <circle cx="256" cy="324" r="7" fill="#FFFFFF"/>
  </g>
</svg>'''

repo_dir = "/Users/chiahua/.gemini/antigravity/scratch/School-LINE_Hub-"

# 1. Write favicon.svg
svg_path = os.path.join(repo_dir, "favicon.svg")
with open(svg_path, "w", encoding="utf-8") as f:
    f.write(SVG_CONTENT)
print("Saved favicon.svg")

# 2. Base image from /tmp/test_chrome.png
base_img_path = "/tmp/test_chrome.png"
if os.path.exists(base_img_path):
    img = Image.open(base_img_path).convert("RGBA")
    
    # 512x512 png
    img.save(os.path.join(repo_dir, "favicon.png"), "PNG")
    print("Saved favicon.png (512x512)")
    
    # 180x180 apple touch icon
    img_180 = img.resize((180, 180), Image.Resampling.LANCZOS)
    img_180.save(os.path.join(repo_dir, "apple-touch-icon.png"), "PNG")
    print("Saved apple-touch-icon.png (180x180)")

    # 32x32 favicon
    img_32 = img.resize((32, 32), Image.Resampling.LANCZOS)
    img_32.save(os.path.join(repo_dir, "favicon-32x32.png"), "PNG")
    print("Saved favicon-32x32.png")

    # 16x16 favicon
    img_16 = img.resize((16, 16), Image.Resampling.LANCZOS)
    img_16.save(os.path.join(repo_dir, "favicon-16x16.png"), "PNG")
    print("Saved favicon-16x16.png")

    # favicon.ico (multi-size 16, 32, 48)
    img_48 = img.resize((48, 48), Image.Resampling.LANCZOS)
    ico_path = os.path.join(repo_dir, "favicon.ico")
    img_48.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    print("Saved favicon.ico")

# Print Base64 string for direct embedding
b64_svg = base64.b64encode(SVG_CONTENT.encode("utf-8")).decode("ascii")
print(f"BASE64_LENGTH: {len(b64_svg)}")
