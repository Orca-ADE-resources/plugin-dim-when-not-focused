# Dim Unfocused Panes (plugin cho Orca)

Làm tối mọi tab group và mọi split terminal **trừ cái đang focus**, giống `unfocused_dim` của Quil.
Mỗi vùng bị dim được phủ đúng màu nền của chính nó (mặc định 50%), nên chữ và đường kẻ nhạt dần vào nền
còn nền giữ nguyên màu, như Quil. Lớp phủ click xuyên qua được, chuyển focus thì mờ/sáng lại trong 120 ms.

- Tab group (editor, terminal, browser…) không chứa focus: dim cả group, kể cả thanh tab.
- Trong group đang focus, terminal chia split: dim các split không có con trỏ.
- Focus nhảy sang sidebar, ô search, menu: pane vừa dùng vẫn sáng (như Quil).
- Chỉ có một pane: không dim gì.
- **Cửa sổ Orca mất focus** (đang làm ở app khác): dim tất cả tab group và terminal, kể cả cái vừa dùng.
  Focus lấy từ cửa sổ Orca (BrowserWindow), nên click vào tab browser bên trong Orca không bị tính là
  mất focus.

## Cài vào Orca

1. Orca → **Settings → Plugins** → bật **Plugin system**.
2. Mục **Development** → ô **Development plugin folder path** → dán đường dẫn thư mục này
   (`G:\code-plugin-orca-dim-when-not-focused`) → **Add path**.
3. Duyệt quyền `events:subscribe` khi Orca hỏi.
4. Plugin chạy lần đầu khi có agent đổi trạng thái hoặc tạo worktree, hoặc bấm `Ctrl+Alt+D` /
   chạy command **Dim Unfocused Panes: Re-apply** từ command palette.

| Command | Phím | Việc |
|---|---|---|
| Dim Unfocused Panes: Settings | `Ctrl+Alt+,` | Mở/đóng bảng chỉnh (góc dưới phải), thay đổi áp ngay và tự lưu |
| Dim Unfocused Panes: Toggle | `Ctrl+Alt+D` | Bật/tắt |
| Dim Unfocused Panes: Stronger | `Ctrl+Alt+=` | Cả hai độ dim đậm thêm 10% (tối đa 90%) |
| Dim Unfocused Panes: Weaker | `Ctrl+Alt+-` | Cả hai độ dim nhạt bớt 10% (tối thiểu 10%) |
| Dim Unfocused Panes: Toggle Dim All When Orca Unfocused | | Bật/tắt dim tất cả khi Orca mất focus |
| Dim Unfocused Panes: Re-apply | | Nạp lại bản hiện tại vào Orca |

Bảng Settings có: bật/tắt, độ dim pane không focus, dim split terminal, dim tất cả khi Orca mất focus và
độ dim riêng cho lúc đó (kéo thanh trượt để xem trước), màu phủ (nền của pane / đen), thời gian chuyển,
nút Reset. `Esc` hoặc `×` để đóng, focus trả về terminal đang dùng.

Cấu hình lưu ở `%APPDATA%\orca\dim-unfocused-panes.json`:

| Key | Mặc định | Ý nghĩa |
|---|---|---|
| `enabled` | `true` | Bật/tắt |
| `amount` | `0.5` | Độ dim pane không focus (0.05–0.95) |
| `blurAmount` | `0.5` | Độ dim khi cửa sổ Orca mất focus (0.05–0.95) |
| `color` | `auto` | Màu phủ; `auto` = nền của chính pane đó (như Quil), hoặc màu CSS bất kỳ (`#000`) |
| `dimSplitPanes` | `true` | Dim cả split không focus trong terminal |
| `dimWhenWindowBlurred` | `true` | Cửa sổ Orca mất focus thì dim tất cả |
| `transitionMs` | `120` | Thời gian chuyển |

## Vì sao không chỉ dùng plugin API

Plugin API v1 của Orca (1.4.x) không cho plugin chạm vào giao diện: panel là iframe sandbox, worker là
process Node riêng, không có contribution CSS/theme. Orca có sẵn **Inactive Pane Opacity** nhưng chỉ áp
cho split bên trong một tab terminal, mặc định 0.9 (gần như không thấy), không áp cho tab group.

Nên worker của plugin làm việc sau (`src/orca-dim.mjs`):

1. `process._debugProcess(<pid main của Orca>)`: cơ chế debug chuẩn của Node (VS Code "attach to process"
   cũng dùng), Orca mở inspector ở `127.0.0.1:9229`.
2. Kết nối, **kiểm tra inspector đúng là main process của Orca** (đúng pid, `process.type === 'browser'`);
   sai thì dừng, không chạy gì.
3. Cài `src/main-install.mjs` vào main process: tiêm `src/renderer-dim.js` vào cửa sổ Orca, tự tiêm lại
   khi renderer reload hoặc mở cửa sổ mới, giữ cấu hình.
4. Đóng inspector. Cổng mở dưới 1 giây.

Phần dim sống trong main process tới khi Orca tắt, nên worker bị Orca dừng sau 5 phút rảnh cũng không sao.

## Giới hạn

- **Tắt plugin trong Settings không gỡ dim ngay**: bấm Toggle cho tắt trước, hoặc khởi động lại Orca.
- Cổng 9229 đang bị debugger khác giữ thì không cài được; Orca ghi log
  `port 9229 is used by another process`, plugin thử lại sau 1 phút.
- Dựa vào data attribute trong DOM của Orca (`data-tab-group-body-id`, `.pane[data-leaf-id]`,
  `data-terminal-overlay-tab-id`, kiểm trên Orca 1.4.222). Orca đổi DOM thì dim có thể ngừng chạy
  (Orca không hỏng); chạy `node test/run-fixture-test.mjs` sau khi sửa selector.
- Inactive Pane Opacity có sẵn của Orca vẫn áp cho split terminal. Muốn chỉ dùng dim của plugin thì
  đặt nó về `1` (Settings → Terminal).

## Dev

```bash
scripts/run-local.bat            # nạp source hiện tại vào Orca đang chạy (reapply), không cần cài lại plugin
node scripts/dim.mjs status      # xem trạng thái; các lệnh khác: settings toggle on off stronger weaker toggle-window-blur reset uninstall
node scripts/dim.mjs set amount=0.6 blurAmount=0.7 color=#000
node test/run-fixture-test.mjs   # test logic dim trên DOM giả lập Orca, chạy Edge/Chrome headless
```

| File | Chạy ở đâu | Việc |
|---|---|---|
| `orca-plugin.json` | Orca | Manifest: command, phím, event kích hoạt worker |
| `worker.mjs` | Worker plugin (Node do Orca fork) | Cài vào Orca khi có event, chuyển command |
| `src/orca-dim.mjs` | Worker / CLI | Mở inspector của Orca, kiểm pid, chạy code, đóng inspector |
| `src/main-install.mjs` | Main process Orca | Giữ/lưu cấu hình, tiêm renderer code vào mọi cửa sổ, báo focus cửa sổ, nhận thay đổi từ bảng Settings |
| `src/renderer-dim.js` | Renderer Orca | Theo dõi focus, vẽ lớp dim, bảng Settings |
| `scripts/dim.mjs` | Terminal | CLI, không cần plugin system |
| `test/` | Edge/Chrome headless | Fixture DOM + 23 kiểm tra |
