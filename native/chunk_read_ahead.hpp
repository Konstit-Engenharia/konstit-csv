#pragma once

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <new>
#include <pthread.h>

namespace csv_native {

enum class chunk_status : int { reading = 0, done = 1, error = 2 };

struct chunk_result {
  uint32_t size;
  chunk_status status;
};

// One producer-owned buffer overlaps decompression with consumption of the previous chunk.
class chunk_read_ahead {
public:
  using read_chunk = chunk_result (*)(void*, uint8_t*, uint32_t, const std::atomic<bool>&);

  static std::unique_ptr<chunk_read_ahead> start(uint32_t capacity, void* source, read_chunk read) {
    auto ahead = std::unique_ptr<chunk_read_ahead>(new (std::nothrow) chunk_read_ahead(capacity, source, read));
    if (!ahead || !ahead->buffer_ || pthread_create(&ahead->thread_, nullptr, produce, ahead.get()) != 0) {
      return nullptr;
    }
    ahead->started_ = true;
    return ahead;
  }

  ~chunk_read_ahead() {
    if (started_) {
      {
        std::lock_guard lock(mutex_);
        stopping_.store(true, std::memory_order_relaxed);
      }
      changed_.notify_one();
      pthread_join(thread_, nullptr);
    }
  }

  uint32_t read(uint8_t* output, uint32_t capacity) {
    std::unique_lock lock(mutex_);
    changed_.wait(lock, [&] { return ready_; });
    const uint32_t size = std::min(capacity, next_.size - offset_);
    std::memcpy(output, buffer_.get() + offset_, size);
    offset_ += size;
    if (offset_ == next_.size) {
      status_ = next_.status;
      ready_ = false;
      lock.unlock();
      changed_.notify_one();
    }
    return size;
  }

  // Only the consumer updates this. EOF or error belongs to the chunk that encountered it.
  chunk_status status() const { return status_; }

private:
  chunk_read_ahead(uint32_t capacity, void* source, read_chunk read)
      : buffer_(new (std::nothrow) uint8_t[capacity]), capacity_(capacity), source_(source), read_(read) {}

  static void* produce(void* context) {
    static_cast<chunk_read_ahead*>(context)->produce_chunks();
    return nullptr;
  }

  void produce_chunks() {
    std::unique_lock lock(mutex_);
    while (true) {
      changed_.wait(lock, [&] { return !ready_ || stopping_.load(std::memory_order_relaxed); });
      if (stopping_.load(std::memory_order_relaxed)) {
        return;
      }
      lock.unlock();
      const auto next = read_(source_, buffer_.get(), capacity_, stopping_);
      lock.lock();
      next_ = next;
      offset_ = 0;
      ready_ = true;
      changed_.notify_one();
      if (next.status != chunk_status::reading) {
        return;
      }
    }
  }

  std::unique_ptr<uint8_t[]> buffer_;
  uint32_t capacity_;
  void* source_;
  read_chunk read_;
  std::mutex mutex_;
  std::condition_variable changed_;
  pthread_t thread_{};
  std::atomic<bool> stopping_{false};
  chunk_result next_{0, chunk_status::reading};
  chunk_status status_ = chunk_status::reading;
  uint32_t offset_ = 0;
  bool ready_ = false;
  bool started_ = false;
};

} // namespace csv_native
