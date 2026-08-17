#!/usr/bin/env ruby

require "yaml"

root = File.expand_path("..", __dir__)
ledger_path = File.join(root, "spec", "conformance.yml")
ledger = YAML.safe_load(File.read(ledger_path), aliases: true)
requirements = ledger.fetch("requirements")
known_test_ids = requirements.flat_map do |requirement|
  acceptance = requirement.fetch("acceptance")
  [acceptance.fetch("behavior").fetch("id"), acceptance.fetch("failure").fetch("id")]
end

title_pattern = /\b(?:test|it)\(\s*["']([^"']+)["']/u
test_id_pattern = /\b[A-Z]{3,5}-\d{3}-[BF]\b/u
claimed_by = Hash.new { |claims, test_id| claims[test_id] = [] }
errors = []

test_roots = %w[apps deploy packaging performance skills src tests tools]
test_files = test_roots.flat_map do |directory|
  Dir.glob(File.join(root, directory, "**", "*.test.ts"))
end.uniq.sort

test_files.each do |file|
  File.foreach(file).with_index(1) do |line, line_number|
    match = line.match(title_pattern)
    next if match.nil?

    title = match[1]
    title.scan(test_id_pattern).each do |test_id|
      unless known_test_ids.include?(test_id)
        errors << "#{file}:#{line_number}: unknown conformance test ID #{test_id}"
        next
      end
      claimed_by[test_id] << "#{file}:#{line_number}"
    end
  end
end

claimed_by.each do |test_id, locations|
  next if locations.length == 1
  errors << "#{test_id} is claimed by more than one test: #{locations.join(", ")}"
end

unless errors.empty?
  warn "Conformance test-ID validation failed:"
  errors.each { |error| warn "- #{error}" }
  exit 1
end

puts "Valid conformance test mapping: #{claimed_by.length} acceptance tests have one implementation test."
