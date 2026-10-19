import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const calendarIndex = () => new Date().getFullYear() * 12 + new Date().getMonth() + 1;

// Advance only on a calendar change. A deliberate selection of an older month
// remains available, and a form being edited is never moved to another month.
export function useMonthRollover(competencies, selectedId, onSelect, blocked = false) {
  const client = useQueryClient();
  const [month, setMonth] = useState(calendarIndex);
  const previous = useRef(month);
  useEffect(() => {
    let observed = calendarIndex();
    const check = () => {
      const current = calendarIndex();
      if (current !== observed) {
        observed = current;
        client.invalidateQueries({ queryKey: ['competencies'] });
        client.invalidateQueries({ queryKey: ['whatsapp'] });
        setMonth(current);
      }
    };
    const timer = setInterval(check, 30_000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    check();
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [client]);
  useEffect(() => {
    if (previous.current === month || blocked) return;
    const selected = competencies.find((item) => String(item.id) === String(selectedId));
    if (selected && selected.year * 12 + selected.month >= month) {
      previous.current = month;
      return;
    }
    const next = competencies.filter((item) => item.generated_at && item.year * 12 + item.month >= month)
      .sort((a, b) => a.year - b.year || a.month - b.month)[0];
    if (next) {
      previous.current = month;
      onSelect(String(next.id));
    }
  }, [month, competencies, selectedId, onSelect, blocked]);
}
