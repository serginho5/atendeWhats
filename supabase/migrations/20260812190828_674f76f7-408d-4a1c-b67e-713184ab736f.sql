INSERT INTO public.subscription (company_id, plan_id, status, trial_ends_at)
SELECT c.id, p.id, 'trialing', now() + interval '14 days'
FROM public.company c, public.plan p
WHERE c.nome = 'AgenteWeb' AND p.slug = 'trial'
AND NOT EXISTS (SELECT 1 FROM public.subscription s WHERE s.company_id = c.id);