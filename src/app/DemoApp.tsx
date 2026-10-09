import { DemoWorkspace } from '../services/demoWorkspace'
import { WorkspacePage } from '../features/workspace/WorkspacePage'

const previewPort = new DemoWorkspace()

interface DemoAppProps {
  readonly roomId: string | null
  readonly onSelectRoom: (roomId: string) => void
  readonly onHome: () => void
}

export default function DemoApp(props: DemoAppProps) {
  return (
    <WorkspacePage
      roomId={props.roomId}
      onSelectRoom={props.onSelectRoom}
      onHome={props.onHome}
      port={previewPort}
      preview={previewPort}
    />
  )
}
