//! Идентификаторы записей: UUID v7 (сортируются по времени создания и не
//! конфликтуют при импорте).

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_time_ordered() {
        let a = new_id();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = new_id();
        assert_ne!(a, b);
        assert!(a < b, "UUID v7 должны сортироваться по времени");
        assert_eq!(uuid::Uuid::parse_str(&a).unwrap().get_version_num(), 7);
    }
}
