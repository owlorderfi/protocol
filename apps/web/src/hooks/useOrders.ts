import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type { Order } from '@owlorderfi/shared';
import { api, ApiError } from '../lib/api';

export function useOrders(enabled: boolean) {
  return useQuery({
    queryKey: ['orders'],
    queryFn: () => api<Order[]>('/orders'),
    enabled,
    refetchInterval: 5_000, // pick up keeper status changes
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<Order>(`/orders/${id}`, { method: 'DELETE' }),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      // An EXECUTING order in the cancel response means the keeper already
      // held the lock, so the API stamped a cooperative-abort request
      // rather than cancelling outright. Be honest: it stops only if the
      // swap hasn't been broadcast yet (the keeper re-checks right before
      // submit). A CANCELLED status is a clean pre-execution cancel.
      if (order.status === 'EXECUTING') {
        toast.success('Cancellation requested — it will stop unless the swap is already on-chain');
      } else {
        toast.success(`Order ${order.id.slice(0, 8)}… cancelled`);
      }
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.error(`Cancel failed: ${msg}`);
    },
  });
}
