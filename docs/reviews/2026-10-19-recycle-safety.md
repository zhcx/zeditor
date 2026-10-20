# 回收站与文件恢复实现说明

适用变更：评估报告中的「P1：误删恢复」。

## 用户行为

- 删除文件或文件夹优先进入系统回收站，保留原名、原路径、操作 UUID 和时间。
- 系统回收站不可用时，尝试将原件原子移动到应用数据目录下的 `recycle/<UUID>/payload`。跨卷、权限等导致安全移动失败时取消删除，原件保留；没有永久删除后备分支。
- 「回收站与文件恢复」只列出 Zeditor 的操作记录，不展示其他应用删除的私人文件。
- Windows/Linux 可以从应用恢复能精确定位的系统回收站项目；macOS 由访达废纸篓恢复，界面明确说明，不能点击应用内恢复冒充成功。
- 同名原路径已存在时拒绝覆盖。用户先移动或重命名同名项目后重试。
- 系统回收站被清空、由系统恢复或暂时无法读取时，记录反映实际可恢复状态。记录不会因时间到期而自动永久删除内容。

## 安全与恢复方式

1. 前端仍需确认删除；后端由原有 `ensure_fs_authorized` 校验当前用户打开的工作区范围。
2. 恢复命令接受操作 UUID，通过本机记录找到原路径，再校验该路径属于当前已打开的工作区；不接受任意恢复源或任意目标路径。
3. 原始条目是符号链接、Windows 目录联接或其他重解析点时取消删除，避免解引用后回收外部目标。普通文件夹内的链接作为链接保留，不递归跟踪；Windows 恢复链接可能因系统权限不足失败，恢复区原件仍保留。
4. 系统项目通过删除前后 ID 差集和原路径共同匹配。重复删除同名文件产生不同 UUID；匹配含糊时只允许用户在系统回收站恢复，不猜测旧条目。
5. Windows 原生删除显式设置 `FOFX_RECYCLEONDELETE`、`FOFX_ADDUNDORECORD` 和 `FOFX_EARLYFAILURE`。列出与恢复采用维护中的 `trash` crate 5.2.9。没有调用系统永久删除 API。
6. 恢复先进入原父目录下新建的 `.zeditor-restore-<UUID>/payload` 暂存位置，再以独占创建方式发布到原路径。文件写完后同步并逐块校验；所有文件完成前保留恢复源。并发新建同名项目也不会被覆盖。
7. 恢复过程中若磁盘写满、父目录改变或文件写入失败，会保留完整恢复源；原路径可能已有部分复制结果。界面显示原因和处理方式，用户检查原路径后重试。暂存路径与操作记录均保留以供人工找回。

## API 与接入

`RecycleStore::new(app_data_dir.join("recycle"))` 提供：

| 方法 | 含义 |
| --- | --- |
| `recycle(path)` | 返回 `RecycleEntry`，优先系统回收、失败时安全暂存 |
| `list()` | 读取操作记录并校准系统/应用恢复源是否可用 |
| `original_path(id)` | 解析并验证记录，供命令执行工作区授权检查 |
| `restore(id)` | 独占恢复到原路径，返回恢复路径 |

对应前端命令为 `delete_fs_item`、`list_recycled_items`、`restore_recycled_item`。列表窗口使用 `RecycleDialog`，通过 `onRestored(path)` 触发工作区刷新。

## 验证范围

模块测试使用独立临时文件和注入的系统回收站适配器，覆盖：中文/空格/emoji 目录、嵌套文件、重复删除同名、UUID 定位、同名冲突、原父目录消失、无效 ID、系统清空、含糊匹配、跨卷暂存失败及独占目录复制。测试不操作用户文件。

另有默认忽略的 `native_recycle_and_restore_disposable_file`，显式执行时仅创建、回收并恢复新建的临时测试文稿，用于实际 Windows/Linux 系统回收站验证。macOS 的废纸篓恢复需要在访达人工验收，尚不能用此测试宣称通过。

2026-10-20 已在本机 Windows 显式执行该真实回收测试：1 项通过、0 失败，临时中文文件成功进入系统回收站并按内容还原。完整后端套件另有 218 项通过、4 项默认忽略。浏览器走查覆盖资源管理器入口、同名冲突反馈、成功恢复后的列表与父目录刷新、键盘焦点和 Escape。

## 依据

- [trash 5.2.9 官方 API](https://docs.rs/trash/5.2.9/trash/)
- [平台限定的列出与恢复](https://docs.rs/trash/5.2.9/trash/os_limited/)
- [Windows IFileOperation 标志](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags)
