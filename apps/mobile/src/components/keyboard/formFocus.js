import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { nextFieldId, orderFields, returnKeyFor } from '../../lib/keyboardLayout';
import { emitInputFocus } from './focusBus';

// "Next" and "Done" for a form. Every form screen's scroll area (KeyboardScroll) is a FormFocusProvider; every shared input (ui.js Input, and the
// request form's description) uses useFormInput. A field says "next" and moves to the next one in reading order, and the last field says
// "done" and closes the keyboard (it never submits). A multiline field keeps Return for a new line. An input outside any form (a search
// box, a modal) simply says "done".
const FormFocusContext = createContext(null);

export function FormFocusProvider({ rtl = false, children }) {
  const fields = useRef(new Map()); // id -> { ref, x, y, seq }
  const seq = useRef(0);
  const [order, setOrder] = useState([]);
  const orderRef = useRef([]);
  const pending = useRef(null);

  // Measures every field in one go (so they share one scroll position) and works out the reading order.
  const measureAll = useCallback(() => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      const list = [...fields.current.entries()];
      if (!list.length) { orderRef.current = []; setOrder([]); return; }
      let left = list.length;
      const done = () => {
        left -= 1;
        if (left > 0) return;
        const next = orderFields([...fields.current.entries()].map(([id, f]) => ({ id, x: f.x, y: f.y, seq: f.seq })), rtl);
        orderRef.current = next;
        setOrder((prev) => (prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next));
      };
      list.forEach(([, f]) => {
        const node = f.ref.current;
        if (!node || !node.measureInWindow) { done(); return; }
        try { node.measureInWindow((x, y) => { f.x = x || 0; f.y = y || 0; done(); }); } catch { done(); }
      });
    }, 30);
  }, [rtl]);

  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);

  const register = useCallback((id, ref) => {
    fields.current.set(id, { ref, x: 0, y: 0, seq: seq.current += 1 });
    measureAll();
    return () => { fields.current.delete(id); measureAll(); };
  }, [measureAll]);

  const submitFrom = useCallback((id) => {
    const nextId = nextFieldId(orderRef.current, id);
    const target = nextId ? fields.current.get(nextId) : null;
    if (target && target.ref.current && target.ref.current.focus) target.ref.current.focus();
    else Keyboard.dismiss();
  }, []);

  const value = useMemo(() => ({ register, submitFrom, measureAll, order }), [register, submitFrom, measureAll, order]);
  return <FormFocusContext.Provider value={value}>{children}</FormFocusContext.Provider>;
}

// The props a text input needs to take part in "next / done". `explicit` is a returnKeyType the caller chose; `onSubmitEditing` and
// `onLayout` are the caller's own and still run. Spread the result on the TextInput.
export function useFormInput({ multiline = false, returnKeyType: explicit, onSubmitEditing, onLayout, onFocus, onContentSizeChange } = {}) {
  const form = useContext(FormFocusContext);
  const id = useId();
  const ref = useRef(null);
  useEffect(() => (form ? form.register(id, ref) : undefined), [form && form.register, id]); // eslint-disable-line react-hooks/exhaustive-deps -- register once per field
  const isLast = form ? form.order.length === 0 || form.order[form.order.length - 1] === id : true;

  const chained = !multiline && !explicit;
  return {
    ref,
    returnKeyType: returnKeyFor({ multiline, isLast, explicit }),
    onLayout: (e) => { if (onLayout) onLayout(e); if (form) form.measureAll(); },
    // the scroll area of a build without the native keyboard module keeps the focused field above the keyboard (the library does this itself)
    onFocus: (e) => { if (onFocus) onFocus(e); emitInputFocus(); },
    ...(multiline ? { onContentSizeChange: (e) => { if (onContentSizeChange) onContentSizeChange(e); emitInputFocus(); } } : (onContentSizeChange ? { onContentSizeChange } : null)),
    // "next" keeps the keyboard up while focus moves on; the last field ("done") lets the keyboard close.
    ...(chained ? { submitBehavior: isLast ? 'blurAndSubmit' : 'submit' } : null),
    ...(chained || onSubmitEditing
      ? { onSubmitEditing: (e) => { if (onSubmitEditing) onSubmitEditing(e); if (chained && form) form.submitFrom(id); } }
      : null),
  };
}
