-- 010: Keep salon/staff rating aggregates in sync with published reviews.
-- Before this migration the seed wrote marketing-style counts (e.g. 96 reviews)
-- that did not match actual review rows, so the card and the reviews API
-- disagreed. All aggregates are now derived from the reviews table.

CREATE OR REPLACE FUNCTION refresh_review_aggregates(p_salon_id uuid, p_staff_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_salon_id IS NOT NULL THEN
    UPDATE salons s
       SET avg_rating = COALESCE(sub.avg_rating, 0),
           review_count = COALESCE(sub.cnt, 0)
      FROM (
        SELECT ROUND(AVG(overall_rating)::numeric, 2) AS avg_rating, COUNT(*)::int AS cnt
          FROM reviews
         WHERE salon_id = p_salon_id AND is_published = TRUE
      ) sub
     WHERE s.id = p_salon_id;
  END IF;

  IF p_staff_id IS NOT NULL THEN
    UPDATE staff_members s
       SET avg_rating = COALESCE(sub.avg_rating, 0),
           review_count = COALESCE(sub.cnt, 0)
      FROM (
        SELECT ROUND(AVG(overall_rating)::numeric, 2) AS avg_rating, COUNT(*)::int AS cnt
          FROM reviews
         WHERE staff_id = p_staff_id AND is_published = TRUE
      ) sub
     WHERE s.id = p_staff_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION sync_review_aggregates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_review_aggregates(OLD.salon_id, OLD.staff_id);
    RETURN OLD;
  END IF;

  PERFORM refresh_review_aggregates(NEW.salon_id, NEW.staff_id);

  IF TG_OP = 'UPDATE'
     AND (OLD.salon_id IS DISTINCT FROM NEW.salon_id OR OLD.staff_id IS DISTINCT FROM NEW.staff_id) THEN
    PERFORM refresh_review_aggregates(OLD.salon_id, OLD.staff_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reviews_sync_aggregates ON reviews;
CREATE TRIGGER trg_reviews_sync_aggregates
AFTER INSERT OR UPDATE OR DELETE ON reviews
FOR EACH ROW EXECUTE FUNCTION sync_review_aggregates();

-- One-time repair so existing rows stop advertising review counts that do not exist.
UPDATE salons s
   SET avg_rating = COALESCE(sub.avg_rating, 0),
       review_count = COALESCE(sub.cnt, 0)
  FROM (
    SELECT salon_id, ROUND(AVG(overall_rating)::numeric, 2) AS avg_rating, COUNT(*)::int AS cnt
      FROM reviews
     WHERE is_published = TRUE
     GROUP BY salon_id
  ) sub
 WHERE s.id = sub.salon_id;

UPDATE salons
   SET avg_rating = 0, review_count = 0
 WHERE id NOT IN (SELECT DISTINCT salon_id FROM reviews WHERE is_published = TRUE);

UPDATE staff_members sm
   SET avg_rating = COALESCE(sub.avg_rating, 0),
       review_count = COALESCE(sub.cnt, 0)
  FROM (
    SELECT staff_id, ROUND(AVG(overall_rating)::numeric, 2) AS avg_rating, COUNT(*)::int AS cnt
      FROM reviews
     WHERE is_published = TRUE AND staff_id IS NOT NULL
     GROUP BY staff_id
  ) sub
 WHERE sm.id = sub.staff_id;

UPDATE staff_members
   SET avg_rating = 0, review_count = 0
 WHERE id NOT IN (
   SELECT DISTINCT staff_id FROM reviews WHERE is_published = TRUE AND staff_id IS NOT NULL
 );
