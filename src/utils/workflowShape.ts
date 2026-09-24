/**
 * 工作流形态的廉价预判：只用正则，不引入 YAML 解析器。
 *
 * 预览组件需要在渲染路径上同步判断「这段内容是不是工作流」，而完整识别
 * 依赖 yaml 包（体积较大）。因此把正则预判单独放在这里：Markdown 预览
 * 先做廉价筛选，确认可能是工作流后再动态加载解析器与查看器。
 */

/** Markdown 代码围栏中可被识别为工作流的语言标记。 */
export const WORKFLOW_FENCE_LANGUAGES = ['yaml', 'yml', 'github-actions-workflow'] as const;

/** `.github/workflows/` 目录下的 YAML 文件按约定直接视为工作流。 */
const WORKFLOW_FILE_PATTERN = /(?:^|[\\/])\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$/i;

/** 顶层 `jobs:` 与 job 级 `runs-on:` / `uses:` 的快速预判。 */
const JOBS_KEY_PATTERN = /^\s*jobs\s*:/m;
const JOB_FIELD_PATTERN = /^\s{2,}(?:runs-on|uses)\s*:/m;

export function isWorkflowFilePath(path: string | null | undefined): boolean {
  if (!path) return false;
  return WORKFLOW_FILE_PATTERN.test(path.trim());
}

export function isYamlFileName(path: string | null | undefined): boolean {
  return Boolean(path && /\.ya?ml$/i.test(path.trim()));
}

/** 顶层存在 `jobs`，且至少有一个 job 声明了 `runs-on` 或 `uses`。 */
export function hasWorkflowShape(source: string): boolean {
  if (!source) return false;
  return JOBS_KEY_PATTERN.test(source) && JOB_FIELD_PATTERN.test(source);
}

/**
 * 是否按工作流打开：`.github/workflows/` 下的 YAML 一律算（即使有语法错误，
 * 也需要展示诊断）；其它位置的 YAML 要求内容形态匹配。
 */
export function isWorkflowLikeFile(path: string | null | undefined, source: string): boolean {
  if (!source) return false;
  if (isWorkflowFilePath(path)) return true;
  return isYamlFileName(path) && hasWorkflowShape(source);
}
