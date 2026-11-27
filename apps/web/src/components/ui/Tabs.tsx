import { useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

interface TabItem {
  content: ReactNode;
  id: string;
  label: string;
}

interface TabsProps {
  "aria-label": string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  tabs: TabItem[];
  value?: string;
}

export function Tabs({ "aria-label": ariaLabel, defaultValue, onValueChange, tabs, value }: TabsProps) {
  const baseId = useId();
  const [internalValue, setInternalValue] = useState(defaultValue ?? tabs[0]?.id ?? "");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedValue = value ?? internalValue;
  const selectedTab = tabs.find((tab) => tab.id === selectedValue) ?? tabs[0];

  function selectTab(id: string) {
    if (value === undefined) setInternalValue(id);
    onValueChange?.(id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    selectTab(nextTab.id);
    tabRefs.current[nextIndex]?.focus();
  }

  if (!selectedTab) return null;

  return (
    <div className="ui-tabs">
      <div aria-label={ariaLabel} className="ui-tabs__list" role="tablist">
        {tabs.map((tab, index) => {
          const selected = tab.id === selectedTab.id;
          return (
            <button
              aria-controls={`${baseId}-${tab.id}-panel`}
              aria-selected={selected}
              className="ui-tabs__tab"
              id={`${baseId}-${tab.id}-tab`}
              key={tab.id}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        aria-labelledby={`${baseId}-${selectedTab.id}-tab`}
        className="ui-tabs__panel"
        id={`${baseId}-${selectedTab.id}-panel`}
        role="tabpanel"
        tabIndex={0}
      >
        {selectedTab.content}
      </div>
    </div>
  );
}
