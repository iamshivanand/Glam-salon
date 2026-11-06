'use client';

import { useState } from 'react';
import { usePartnerReviews, useReplyReview } from '@/lib/api';
import { useAuth } from '@/lib/store';

interface Review {
  id: string;
  overall_rating: number;
  hygiene_rating: number;
  review_text: string | null;
  owner_reply: string | null;
  resolution_status: string;
  created_at: string;
  customer_name: string;
  staff_name: string | null;
}

function ReviewCard({ review }: { review: Review }) {
  const [reply, setReply] = useState(review.owner_reply ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const submit = useReplyReview();

  const send = async () => {
    setProblem(null);
    setSaved(false);
    try {
      if (!reply.trim()) throw new Error('Write a reply first');
      await submit.mutateAsync({
        id: review.id,
        owner_reply: reply.trim(),
        resolution_status: review.resolution_status === 'OPEN_ALERT' ? 'RESOLVED' : undefined,
      });
      setSaved(true);
    } catch (err: any) {
      setProblem(err.message);
    }
  };

  return (
    <div className={`card p-5 ${review.resolution_status === 'OPEN_ALERT' ? 'border-red-300' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{review.customer_name}</p>
          <p className="text-xs opacity-60">
            {new Date(review.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
            {review.staff_name ? ` · ${review.staff_name}` : ''}
          </p>
        </div>
        <div className="text-right">
          <p className="text-accent">{'★'.repeat(review.overall_rating)}<span className="opacity-30">{'★'.repeat(5 - review.overall_rating)}</span></p>
          <p className="text-[11px] opacity-60">hygiene {review.hygiene_rating}/5</p>
        </div>
      </div>

      <p className="mt-3 text-sm">{review.review_text ?? 'No comment left.'}</p>

      {review.resolution_status === 'OPEN_ALERT' && (
        <p className="text-xs text-red-700 mt-2">Open service alert — reply and resolve.</p>
      )}

      {review.owner_reply && (
        <div className="mt-3 border-l-2 border-accent/50 pl-3">
          <p className="text-[11px] opacity-60">Your reply</p>
          <p className="text-sm">{review.owner_reply}</p>
        </div>
      )}

      <div className="mt-3 space-y-2">
        <textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="Reply publicly to this customer…"
          className="w-full border border-line rounded-xl px-3 py-2 bg-transparent text-sm"
        />
        {problem && <p className="text-xs text-red-600">{problem}</p>}
        <div className="flex items-center gap-3">
          <button onClick={send} disabled={submit.isPending} className="btn-primary !py-2 !px-4 text-sm">
            {submit.isPending ? 'Saving…' : review.owner_reply ? 'Update reply' : 'Reply'}
          </button>
          {saved && <span className="text-xs text-green-700">Saved</span>}
        </div>
      </div>
    </div>
  );
}

export default function AdminReviews() {
  const { user } = useAuth();
  const { data, isLoading } = usePartnerReviews(!!user);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="font-display text-4xl">Reviews</h1>
          <p className="text-sm opacity-60 mt-1">Customer feedback and public owner replies.</p>
        </div>
        {!!data?.open_alerts && (
          <span className="chip !py-1 !px-3 border-red-300 text-red-700">{data.open_alerts} open alert{data.open_alerts === 1 ? '' : 's'}</span>
        )}
      </div>

      {isLoading && <p>Loading reviews…</p>}
      {!isLoading && !data?.reviews.length && <p className="text-sm opacity-60">No reviews yet.</p>}

      <div className="grid lg:grid-cols-2 gap-4">
        {(data?.reviews ?? []).map((r) => <ReviewCard key={r.id} review={r} />)}
      </div>
    </div>
  );
}
