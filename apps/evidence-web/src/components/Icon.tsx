import React from "react";
import { consoleIconComponents, type ConsoleIconName } from "../components/icons.js";

interface IconProps {
  name: ConsoleIconName;
  title?: string;
  className?: string;
}

export function Icon({ name, title, className }: IconProps) {
  const Comp = consoleIconComponents[name];
  if (!Comp) return null;
  return React.createElement(Comp, { title, className });
}
