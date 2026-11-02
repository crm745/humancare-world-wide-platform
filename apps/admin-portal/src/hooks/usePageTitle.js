import { useEffect } from 'react';

const SUFFIX = 'HumanCare Admin';

/** Sets the browser tab / history title for the current page. */
export function usePageTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · ${SUFFIX}` : SUFFIX;
  }, [title]);
}
