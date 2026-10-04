import { createElement, type SVGProps } from 'react';
import { ICON_GEOMETRY, type IconName } from './iconGeometry';

interface AppIconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  name: IconName;
  size?: number;
  label?: string;
}

/** 装饰图标的名称由宿主按钮的文字、aria-label 和悬停提示提供。 */
export function AppIcon({ name, size = 20, label, className = '', ...props }: AppIconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={`app-icon ${className}`} data-icon={name} aria-hidden="true" focusable="false" {...props}>
      {ICON_GEOMETRY[name].map((shape, index) => createElement(shape.tag, { ...shape.attrs, key: index }))}
      {label && <text x="12" y="17" textAnchor="middle" className="app-icon-label" fontSize={label.length > 3 ? 6.5 : label.length > 2 ? 7.5 : 9}>{label}</text>}
    </svg>
  );
}
