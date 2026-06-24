import React from "react";
import {
  Activity,
  Braces,
  Check,
  CheckCircle2,
  CircleDollarSign,
  CircleHelp,
  CircleX,
  ClipboardList,
  Coins,
  Copy,
  Database,
  FileJson,
  Hash,
  Monitor,
  Network,
  PanelRight,
  Radio,
  ReceiptText,
  RotateCw,
  Route,
  Send,
  Server,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Terminal,
  Trash2,
  Workflow,
  Zap,
  type LucideIcon
} from "lucide-react";

export const ICON_SIZE = 16;
export const ICON_STROKE_WIDTH = 1.75;

export type ConsoleIconName =
  | "ActionPay"
  | "ActionReplay"
  | "ActionRetry"
  | "ActionSend"
  | "Activity"
  | "ActorClient"
  | "ActorFiber"
  | "ActorProtectedApi"
  | "ActorServer"
  | "AttackReplay"
  | "CanonicalParity"
  | "ClearLog"
  | "Copy"
  | "Copied"
  | "Evidence"
  | "FiberNetwork"
  | "F402"
  | "Method"
  | "PaymentReceipt"
  | "Price"
  | "ReportArtifact"
  | "RequestScenario"
  | "ResourceHash"
  | "Route"
  | "SecurityMatrix"
  | "StatusFailed"
  | "StatusPassed"
  | "StatusUnavailable"
  | "Terminal"
  | "Timeline"
  | "VectorHarness";

type WrappedIconProps = {
  title?: string;
  className?: string;
};

function wrapIcon(name: ConsoleIconName, Icon: LucideIcon) {
  return function ConsoleIcon({ title, className }: WrappedIconProps) {
    return (
      <Icon
        aria-hidden={title ? undefined : true}
        aria-label={title}
        className={className ?? "lucide-ui-icon"}
        color="currentColor"
        focusable="false"
        role={title ? "img" : undefined}
        size={ICON_SIZE}
        strokeWidth={ICON_STROKE_WIDTH}
        data-console-icon={name}
      />
    );
  };
}

export const StatusPassedIcon = wrapIcon("StatusPassed", CheckCircle2);
export const StatusFailedIcon = wrapIcon("StatusFailed", CircleX);
export const StatusUnavailableIcon = wrapIcon("StatusUnavailable", CircleHelp);
export const RequestScenarioIcon = wrapIcon("RequestScenario", ClipboardList);
export const FiberNetworkIcon = wrapIcon("FiberNetwork", Network);
export const TimelineIcon = wrapIcon("Timeline", Workflow);
export const EvidenceIcon = wrapIcon("Evidence", Braces);
export const TerminalIcon = wrapIcon("Terminal", Terminal);
export const CopyIcon = wrapIcon("Copy", Copy);
export const CopiedIcon = wrapIcon("Copied", Check);
export const ClearLogIcon = wrapIcon("ClearLog", Trash2);
export const ActionSendIcon = wrapIcon("ActionSend", Send);
export const ActivityIcon = wrapIcon("Activity", Activity);
export const ActionPayIcon = wrapIcon("ActionPay", Zap);
export const ActionRetryIcon = wrapIcon("ActionRetry", RotateCw);
export const ActionReplayIcon = wrapIcon("ActionReplay", ShieldX);
export const ActorClientIcon = wrapIcon("ActorClient", Monitor);
export const ActorServerIcon = wrapIcon("ActorServer", Server);
export const ActorFiberIcon = wrapIcon("ActorFiber", Network);
export const ActorProtectedApiIcon = wrapIcon("ActorProtectedApi", ShieldCheck);
export const ReportArtifactIcon = wrapIcon("ReportArtifact", FileJson);
export const PaymentReceiptIcon = wrapIcon("PaymentReceipt", ReceiptText);
export const SecurityMatrixIcon = wrapIcon("SecurityMatrix", ShieldAlert);
export const CanonicalParityIcon = wrapIcon("CanonicalParity", PanelRight);
export const PriceIcon = wrapIcon("Price", Coins);
export const MethodIcon = wrapIcon("Method", CircleDollarSign);
export const ResourceHashIcon = wrapIcon("ResourceHash", Hash);
export const RouteIcon = wrapIcon("Route", Route);
export const F402Icon = wrapIcon("F402", Radio);
export const VectorHarnessIcon = wrapIcon("VectorHarness", Database);
export const AttackReplayIcon = wrapIcon("AttackReplay", ShieldAlert);

export const consoleIconComponents = {
  ActionPay: ActionPayIcon,
  ActionReplay: ActionReplayIcon,
  ActionRetry: ActionRetryIcon,
  ActionSend: ActionSendIcon,
  Activity: ActivityIcon,
  ActorClient: ActorClientIcon,
  ActorFiber: ActorFiberIcon,
  ActorProtectedApi: ActorProtectedApiIcon,
  ActorServer: ActorServerIcon,
  AttackReplay: AttackReplayIcon,
  CanonicalParity: CanonicalParityIcon,
  ClearLog: ClearLogIcon,
  Copy: CopyIcon,
  Copied: CopiedIcon,
  Evidence: EvidenceIcon,
  F402: F402Icon,
  FiberNetwork: FiberNetworkIcon,
  Method: MethodIcon,
  PaymentReceipt: PaymentReceiptIcon,
  Price: PriceIcon,
  ReportArtifact: ReportArtifactIcon,
  RequestScenario: RequestScenarioIcon,
  ResourceHash: ResourceHashIcon,
  Route: RouteIcon,
  SecurityMatrix: SecurityMatrixIcon,
  StatusFailed: StatusFailedIcon,
  StatusPassed: StatusPassedIcon,
  StatusUnavailable: StatusUnavailableIcon,
  Terminal: TerminalIcon,
  Timeline: TimelineIcon,
  VectorHarness: VectorHarnessIcon
} satisfies Record<ConsoleIconName, React.ComponentType<WrappedIconProps>>;

export const consoleIconNames = Object.keys(consoleIconComponents).sort() as ConsoleIconName[];
