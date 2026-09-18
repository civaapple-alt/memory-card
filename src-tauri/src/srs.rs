//! SM-2 间隔重复调度（PRD §10）。
//!
//! 相对教科书 SM-2 的两处调整，都是为了"这是一个真实会被用的工具"：
//! 1. 忘记（rating 1）回到 10 分钟而不是 1 天 —— 当天还能再见一次。
//! 2. 逾期过久的卡由调用方休眠（阈值 `SUSPEND_AFTER_OVERDUE_DAYS`，在
//!    lib.rs 的 `list_due_cards` 里对 queue 批量生效），避免复习队列雪崩。

pub const MIN_EASE: f64 = 1.3;
pub const MAX_EASE: f64 = 3.0;
pub const MAX_INTERVAL_DAYS: f64 = 365.0;
/// 逾期超过这么多天就不进当日队列，改为休眠（PRD §10 债务保护）。
///
/// 唯一的判定点：lib.rs `list_due_cards` 里那条批量 UPDATE。
/// 放在这里是为了让"多久算太久"这件事只有一个常量。
pub const SUSPEND_AFTER_OVERDUE_DAYS: f64 = 14.0;

#[derive(Debug, Clone, Copy)]
pub struct ScheduleInput {
    pub interval_days: f64,
    pub ease: f64,
    pub reps: i64,
    pub lapses: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct ScheduleOutput {
    pub interval_days: f64,
    pub ease: f64,
    pub reps: i64,
    pub lapses: i64,
    pub state: &'static str,
}

const TEN_MINUTES: f64 = 10.0 / 1440.0;

/// rating: 1 忘记 / 2 模糊 / 3 记得 / 4 太简单
pub fn schedule(input: ScheduleInput, rating: i64) -> ScheduleOutput {
    let ScheduleInput { interval_days, ease, reps, lapses } = input;
    let mut ease = ease;
    let mut reps = reps;
    let mut lapses = lapses;
    let interval;

    match rating {
        // 忘记：重置进度，10 分钟后再来一次
        1 => {
            reps = 0;
            lapses += 1;
            ease = (ease - 0.20).max(MIN_EASE);
            interval = TEN_MINUTES;
        }
        // 模糊：仍然推进，但推进得很小
        2 => {
            reps += 1;
            ease = (ease - 0.15).max(MIN_EASE);
            interval = if reps <= 1 { TEN_MINUTES } else { (interval_days * 1.2).max(TEN_MINUTES) };
        }
        // 记得：标准 SM-2 曲线
        3 => {
            reps += 1;
            interval = match reps {
                1 => 1.0,
                2 => 6.0,
                _ => interval_days * ease,
            };
        }
        // 太简单：推进更激进，并提高 ease
        _ => {
            reps += 1;
            ease = (ease + 0.15).min(MAX_EASE);
            interval = match reps {
                1 => 2.0,
                2 => 8.0,
                _ => interval_days * ease * 1.3,
            };
        }
    }

    let interval = interval.clamp(0.0, MAX_INTERVAL_DAYS);
    let state = if interval >= 1.0 { "review" } else { "learning" };

    ScheduleOutput { interval_days: interval, ease, reps, lapses, state }
}

pub fn interval_to_due_at(interval_days: f64, now: i64) -> i64 {
    now + (interval_days * 86_400.0).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> ScheduleInput {
        ScheduleInput { interval_days: 0.0, ease: 2.5, reps: 0, lapses: 0 }
    }

    #[test]
    fn first_good_review_is_one_day() {
        let out = schedule(base(), 3);
        assert_eq!(out.interval_days, 1.0);
        assert_eq!(out.state, "review");
    }

    #[test]
    fn second_good_review_is_six_days() {
        let out = schedule(ScheduleInput { interval_days: 1.0, ease: 2.5, reps: 1, lapses: 0 }, 3);
        assert_eq!(out.interval_days, 6.0);
    }

    #[test]
    fn third_good_review_multiplies_by_ease() {
        let out = schedule(ScheduleInput { interval_days: 6.0, ease: 2.5, reps: 2, lapses: 0 }, 3);
        assert_eq!(out.interval_days, 15.0);
    }

    #[test]
    fn again_resets_reps_and_counts_lapse() {
        let out = schedule(ScheduleInput { interval_days: 30.0, ease: 2.5, reps: 5, lapses: 1 }, 1);
        assert_eq!(out.reps, 0);
        assert_eq!(out.lapses, 2);
        assert!(out.interval_days < 1.0, "忘记后必须当天还能再见一次");
        assert_eq!(out.state, "learning");
    }

    #[test]
    fn ease_never_below_floor() {
        let mut input = ScheduleInput { interval_days: 1.0, ease: 1.3, reps: 1, lapses: 0 };
        for _ in 0..5 {
            let out = schedule(input, 1);
            assert!(out.ease >= MIN_EASE);
            input.ease = out.ease;
        }
    }

    #[test]
    fn interval_is_capped() {
        let out = schedule(ScheduleInput { interval_days: 300.0, ease: 3.0, reps: 9, lapses: 0 }, 4);
        assert!(out.interval_days <= MAX_INTERVAL_DAYS);
    }

}
