(module
  (import "e" "f" (func $jsFunc (param i32 i32 i32) (result i32)))
  (func (export "f") (param i32 i64) (result i32)
    local.get 0
    local.get 1
    i32.wrap_i64
    local.get 1
    i64.const 32
    i64.shr_u
    i32.wrap_i64
    call $jsFunc
    return)
)