import * as React from "react"
import { SVGProps } from "react"
const SvgComponent = (props: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    strokeWidth={1.5}
    color="#000"
    {...props}
  >
    <path
      stroke="#000"
      d="M16.82 20.768 3.753 3.968A.6.6 0 0 1 4.227 3h2.48a.6.6 0 0 1 .473.232l13.067 16.8a.6.6 0 0 1-.474.968h-2.48a.6.6 0 0 1-.473-.232Z"
    />
    <path stroke="#000" strokeLinecap="round" d="M20 3 4 21" />
  </svg>
)
export { SvgComponent as XIcon }
