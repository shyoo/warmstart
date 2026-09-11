/**
 * The SQL that says what a task's headline quality *is*: the mean over every completed, scored peer
 * review **and** every direct operator rating, with the count as its denominator and the newest of
 * either as its time. ⛔ Its own module because both `review.ts` (every write) and `db.ts` (migration 65, which
 * ran it once over every task that already carried a rating) need it, and `db.ts` cannot import the
 * module that imports it. A change here is owed a migration that replays it.
 *
 * ⚠️ Peer and operator grades are folded together on purpose: `quality.ts` already unions the two
 * tables for the Analytics page, and a task table that showed a different number from the page
 * beside it would be two answers to one question. `quality_review_id` / `quality_reviewer` name the
 * newest *peer* review, or nothing — a rating has no reviewer adapter to name — and are re-derived
 * here too, since `deleteReview` used to leave them pointing at a row it had just removed.
 * `qualityManualCount` on the task says how many of the count are the operator's.
 */
export const TASK_QUALITY_RECOMPUTE_SQL = `
  update tasks
     set quality_review_score = (
           select round(avg(score), 1) from (
             select q.composite as score from quality_reviews q
              where q.task_id = tasks.id and q.status = 'complete' and q.composite is not null
             union all
             select m.score from manual_reviews m where m.task_id = tasks.id
           )
         ),
         quality_review_count = (
           (select count(q.composite) from quality_reviews q
             where q.task_id = tasks.id and q.status = 'complete' and q.composite is not null)
           + (select count(*) from manual_reviews m where m.task_id = tasks.id)
         ),
         quality_review_at = (
           select max(at) from (
             select q.completed_at as at from quality_reviews q
              where q.task_id = tasks.id and q.status = 'complete' and q.composite is not null
             union all
             select m.created_at from manual_reviews m where m.task_id = tasks.id
           )
         ),
         quality_review_id = (
           select q.id from quality_reviews q
            where q.task_id = tasks.id and q.status = 'complete' and q.composite is not null
            order by q.completed_at desc limit 1
         ),
         quality_reviewer = (
           select q.reviewer_adapter from quality_reviews q
            where q.task_id = tasks.id and q.status = 'complete' and q.composite is not null
            order by q.completed_at desc limit 1
         )`
