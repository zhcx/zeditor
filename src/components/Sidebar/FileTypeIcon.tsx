import { resolveFileIcon, type FileIconShape } from '../../utils/fileIcon';
import { AppIcon } from '../Icons/AppIcon';
import type { IconName } from '../Icons/iconGeometry';

const fileIconNames = {"markdown":"fileMarkdown","brace":"fileCode","code":"fileCode","config":"settings","git":"git","docker":"boxes","image":"image","audio":"audio","video":"video","archive":"archive","office":"fileLabel","sheet":"fileSheet","terminal":"terminal","database":"database","notebook":"notebook","package":"package","lock":"lock","book":"book","mail":"mail","font":"font","binary":"fileLabel","document":"fileText","language":"fileLabel"} as const satisfies Record<FileIconShape, IconName>;

export function FileTypeIcon({ filename }: { filename: string }) {
  const icon = resolveFileIcon(filename);
  return <AppIcon name={fileIconNames[icon.shape]} label={['office', 'language', 'binary'].includes(icon.shape) ? icon.label : undefined} size={20} className={`explorer-icon file-icon vscode-file-icon file-kind-${icon.kind}`} />;
}
