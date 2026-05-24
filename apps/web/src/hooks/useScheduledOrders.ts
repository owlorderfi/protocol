import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type { ScheduledOrder } from '@owlorderfi/shared';
import { api, ApiError } from '../lib/api';

/**
 * List the user's scheduled orders (DCA + TWAP combined — same endpoint).
 * Refetches every 5s so the UI picks up keeper progress (slicesExecuted
 * increments, status transitions to COMPLETED, etc.) without a manual
 * reload.
 */
export function useScheduledOrders(enabled: boolean) {
  return useQuery({
    queryKey: ['scheduled-orders'],
    queryFn: () => api<ScheduledOrder[]>('/scheduled-orders'),
    enabled,
    refetchInterval: 5_000,
  });
}

/**
 * Off-chain cancel — flips DB status to CANCELLED so the keeper stops
 * picking up future slices. For full cancellation that survives an
 * in-flight keeper tx, the UI should ALSO prompt the user to call
 * `cancelOrder(nonce)` on the contract. That's wired separately in
 * the cancel button so we keep this hook focused.
 */
export function useCancelScheduledOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<ScheduledOrder>(`/scheduled-orders/${id}`, { method: 'DELETE' }),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ['scheduled-orders'] });
      toast.success(`Scheduled order ${order.id.slice(0, 8)}… stopped`);
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.error(`Cancel failed: ${msg}`);
    },
  });
}
